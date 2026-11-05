package main

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
)

// Feature is a per-tile terrain feature from a map's optional features.png.
// The values are the 2-bit codes written to features.bin and must match
// TerrainFeature in ../packages/engine-api/src/game/TerrainFeature.ts.
type Feature uint8

const (
	FeatureNone   Feature = 0
	FeatureForest Feature = 1
	FeatureRiver  Feature = 2 // a land tile crossed by a river
	FeatureFord   Feature = 3 // a river tile that crosses at normal cost
)

// featuresVersion is written to manifest.json as features.version. It must
// match TERRAIN_FEATURES_VERSION in ../packages/engine-lib/src/game/TerrainFeatures.ts.
const featuresVersion = 1

// features.png colours. A pixel is a feature only when its RGB matches one of
// these exactly and its alpha is at least featureMinAlpha; every other pixel
// (transparent, white, anything else) is no feature. Don't antialias.
var featureColors = map[[3]uint8]Feature{
	{0, 128, 0}:   FeatureForest, // #008000
	{0, 0, 255}:   FeatureRiver,  // #0000FF
	{255, 255, 0}: FeatureFord,   // #FFFF00
}

const featureMinAlpha = 128

// Thumbnail colours for feature tiles, drawn over the terrain colour.
var featureThumbnailColors = [4]RGBA{
	FeatureForest: {R: 110, G: 160, B: 90, A: 255},
	FeatureRiver:  {R: 80, G: 140, B: 220, A: 255},
	FeatureFord:   {R: 200, G: 215, B: 170, A: 255},
}

// decodeFeatures reads features.png into a [x][y] grid the size of the
// (cropped) map. The image must match image.png's size before or after the
// crop to a multiple of 4.
func decodeFeatures(buffer []byte, width, height, srcWidth, srcHeight int) ([][]Feature, error) {
	img, err := png.Decode(bytes.NewReader(buffer))
	if err != nil {
		return nil, fmt.Errorf("features.png failed to decode: %w", err)
	}
	size := img.Bounds().Size()
	matchesMap := size.X == width && size.Y == height
	matchesSource := size.X == srcWidth && size.Y == srcHeight
	if !matchesMap && !matchesSource {
		return nil, fmt.Errorf("features.png dimensions (%dx%d) do not match image.png (%dx%d)", size.X, size.Y, srcWidth, srcHeight)
	}
	origin := img.Bounds().Min
	features := make([][]Feature, width)
	for x := 0; x < width; x++ {
		features[x] = make([]Feature, height)
		for y := 0; y < height; y++ {
			features[x][y] = featureFromColor(img.At(origin.X+x, origin.Y+y))
		}
	}
	return features, nil
}

// featureFromColor maps one features.png pixel to its feature.
func featureFromColor(c color.Color) Feature {
	n := color.NRGBAModel.Convert(c).(color.NRGBA)
	if n.A < featureMinAlpha {
		return FeatureNone
	}
	return featureColors[[3]uint8{n.R, n.G, n.B}]
}

// maskFeatures clears features on tiles that are not land: rivers and fords
// are land tiles, and nothing grows on water or impassable terrain. Tiles
// that changed type during generation (removed islands) are cleared too.
func maskFeatures(features [][]Feature, terrain [][]Terrain) {
	for x := range features {
		for y := range features[x] {
			if terrain[x][y].Type != Land {
				features[x][y] = FeatureNone
			}
		}
	}
}

// downscaleFeatures halves the feature grid onto the map4x terrain, one
// output tile per 2x2 block. Rivers are thin lines, so any river or ford in
// a block keeps it (a ford wins over the river around it) and rivers stay
// unbroken; forest needs at least half the block.
func downscaleFeatures(features [][]Feature, terrain4x [][]Terrain) [][]Feature {
	width := len(terrain4x)
	height := len(terrain4x[0])
	out := make([][]Feature, width)
	for x := 0; x < width; x++ {
		out[x] = make([]Feature, height)
		for y := 0; y < height; y++ {
			if terrain4x[x][y].Type != Land {
				continue
			}
			var counts [4]int
			for dx := 0; dx < 2; dx++ {
				for dy := 0; dy < 2; dy++ {
					counts[features[2*x+dx][2*y+dy]]++
				}
			}
			switch {
			case counts[FeatureFord] > 0:
				out[x][y] = FeatureFord
			case counts[FeatureRiver] > 0:
				out[x][y] = FeatureRiver
			case counts[FeatureForest] >= 2:
				out[x][y] = FeatureForest
			}
		}
	}
	return out
}

// packFeatures serializes the feature grid: one 2-bit code per tile in
// row-major order (y*width+x), four tiles per byte, lowest bits first.
// The game reads tile i as (bytes[i>>2] >> ((i&3)*2)) & 3.
func packFeatures(features [][]Feature) []byte {
	width := len(features)
	height := len(features[0])
	packed := make([]byte, (width*height+3)/4)
	for x := 0; x < width; x++ {
		for y := 0; y < height; y++ {
			i := y*width + x
			packed[i>>2] |= byte(features[x][y]&3) << ((i & 3) * 2)
		}
	}
	return packed
}

// countFeatures returns how many tiles carry each feature.
func countFeatures(features [][]Feature) [4]int {
	var counts [4]int
	for x := range features {
		for y := range features[x] {
			counts[features[x][y]]++
		}
	}
	return counts
}

// tintThumbnail paints feature tiles onto a thumbnail made from the same
// grid by createMapThumbnail at the same quality.
func tintThumbnail(img *image.RGBA, features [][]Feature, quality float64) {
	srcWidth := len(features)
	srcHeight := len(features[0])
	bounds := img.Bounds()
	for x := 0; x < bounds.Dx(); x++ {
		for y := 0; y < bounds.Dy(); y++ {
			srcX := min(int(float64(x)/quality), srcWidth-1)
			srcY := min(int(float64(y)/quality), srcHeight-1)
			f := features[srcX][srcY]
			if f == FeatureNone {
				continue
			}
			c := featureThumbnailColors[f]
			img.Set(x, y, color.RGBA{R: c.R, G: c.G, B: c.B, A: c.A})
		}
	}
}

// writeFeatureFiles writes features.bin and features4x.bin and lists the
// layer in the manifest, or removes stale feature files when the map has no
// features.png, so maps without one ship exactly as before.
func writeFeatureFiles(mapDir string, result MapResult, manifest map[string]interface{}) error {
	files := map[string][]byte{
		"features.bin":   result.Features,
		"features4x.bin": result.Features4x,
	}
	for name, data := range files {
		path := filepath.Join(mapDir, name)
		if result.Features == nil {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
			continue
		}
		if err := os.WriteFile(path, data, 0644); err != nil {
			return err
		}
	}
	if result.Features == nil {
		delete(manifest, "features")
	} else {
		manifest["features"] = map[string]interface{}{"version": featuresVersion}
	}
	return nil
}
