package main

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"testing"
)

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestFeatureFromColor(t *testing.T) {
	cases := []struct {
		c    color.Color
		want Feature
	}{
		{color.NRGBA{0, 128, 0, 255}, FeatureForest},
		{color.NRGBA{0, 0, 255, 255}, FeatureRiver},
		{color.NRGBA{255, 255, 0, 255}, FeatureFord},
		{color.NRGBA{0, 0, 255, 0}, FeatureNone},   // transparent
		{color.NRGBA{0, 0, 254, 255}, FeatureNone}, // not an exact match
		{color.NRGBA{255, 255, 255, 255}, FeatureNone},
	}
	for _, c := range cases {
		if got := featureFromColor(c.c); got != c.want {
			t.Errorf("featureFromColor(%v) = %d, want %d", c.c, got, c.want)
		}
	}
}

// The layout must match terrainFeatureAt in
// packages/engine-lib/src/game/TerrainFeatures.ts.
func TestPackFeaturesLayout(t *testing.T) {
	// 4x2 grid, row-major refs 0..7.
	features := [][]Feature{
		{FeatureForest, FeatureNone}, // x=0: refs 0, 4
		{FeatureRiver, FeatureFord},  // x=1: refs 1, 5
		{FeatureFord, FeatureForest}, // x=2: refs 2, 6
		{FeatureNone, FeatureRiver},  // x=3: refs 3, 7
	}
	got := packFeatures(features)
	want := []byte{
		1 | 2<<2 | 3<<4 | 0<<6,
		0 | 3<<2 | 1<<4 | 2<<6,
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("packFeatures = %08b, want %08b", got, want)
	}
}

func TestDownscaleFeatures(t *testing.T) {
	f := func(rows ...[]Feature) [][]Feature {
		// rows are y-major for readability; convert to [x][y].
		out := make([][]Feature, len(rows[0]))
		for x := range out {
			out[x] = make([]Feature, len(rows))
			for y := range rows {
				out[x][y] = rows[y][x]
			}
		}
		return out
	}
	N, F, R, D := FeatureNone, FeatureForest, FeatureRiver, FeatureFord
	full := f(
		[]Feature{R, N, F, N, F, F, N, N},
		[]Feature{N, N, N, N, F, N, R, D},
	)
	land := make([][]Terrain, 4)
	for x := range land {
		land[x] = []Terrain{{Type: Land}}
	}
	got := downscaleFeatures(full, land)
	want := []Feature{R, N, F, D}
	for x, w := range want {
		if got[x][0] != w {
			t.Errorf("block %d = %d, want %d", x, got[x][0], w)
		}
	}

	// Water tiles never carry a feature.
	land[0][0].Type = Water
	if got := downscaleFeatures(full, land); got[0][0] != FeatureNone {
		t.Errorf("water block = %d, want none", got[0][0])
	}
}

func TestGenerateMapWithFeatures(t *testing.T) {
	const w, h = 64, 64
	terrainImg := image.NewNRGBA(image.Rect(0, 0, w, h))
	featuresImg := image.NewNRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			if x < 8 {
				// Water strip on the left.
				terrainImg.Set(x, y, color.NRGBA{0, 0, 106, 255})
				featuresImg.Set(x, y, color.NRGBA{0, 128, 0, 255})
				continue
			}
			terrainImg.Set(x, y, color.NRGBA{140, 140, 140, 255})
			switch {
			case x == 30 && y >= 20 && y < 24:
				featuresImg.Set(x, y, color.NRGBA{255, 255, 0, 255})
			case x == 30:
				featuresImg.Set(x, y, color.NRGBA{0, 0, 255, 255})
			case x > 40:
				featuresImg.Set(x, y, color.NRGBA{0, 128, 0, 255})
			}
		}
	}

	ctx := ContextWithLogger(context.Background(), discardLogger())
	result, err := GenerateMap(ctx, GeneratorArgs{
		Name:           "features_test",
		ImageBuffer:    encodePNG(t, terrainImg),
		FeaturesBuffer: encodePNG(t, featuresImg),
		RemoveSmall:    false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Features) != w*h/4 || len(result.Features4x) != w*h/16 {
		t.Fatalf("feature layer sizes %d and %d", len(result.Features), len(result.Features4x))
	}
	at := func(packed []byte, width, x, y int) Feature {
		i := y*width + x
		return Feature(packed[i>>2]>>((i&3)*2)) & 3
	}
	if got := at(result.Features, w, 2, 10); got != FeatureNone {
		t.Errorf("forest on water kept: %d", got)
	}
	if got := at(result.Features, w, 30, 10); got != FeatureRiver {
		t.Errorf("river tile = %d", got)
	}
	if got := at(result.Features, w, 30, 21); got != FeatureFord {
		t.Errorf("ford tile = %d", got)
	}
	if got := at(result.Features, w, 50, 50); got != FeatureForest {
		t.Errorf("forest tile = %d", got)
	}
	if got := at(result.Features4x, w/2, 15, 5); got != FeatureRiver {
		t.Errorf("map4x river tile = %d", got)
	}
	if got := at(result.Features4x, w/2, 15, 10); got != FeatureFord {
		t.Errorf("map4x ford tile = %d", got)
	}

	// Without features.png the layer is absent.
	plain, err := GenerateMap(ctx, GeneratorArgs{
		Name:        "features_test",
		ImageBuffer: encodePNG(t, terrainImg),
	})
	if err != nil {
		t.Fatal(err)
	}
	if plain.Features != nil || plain.Features4x != nil {
		t.Error("map without features.png got a feature layer")
	}
	if !bytes.Equal(plain.Map.Data, result.Map.Data) {
		t.Error("features changed the terrain")
	}
}

func TestFeaturesSizeMismatch(t *testing.T) {
	terrainImg := image.NewNRGBA(image.Rect(0, 0, 16, 16))
	for x := 0; x < 16; x++ {
		for y := 0; y < 16; y++ {
			terrainImg.Set(x, y, color.NRGBA{140, 140, 140, 255})
		}
	}
	ctx := ContextWithLogger(context.Background(), discardLogger())
	_, err := GenerateMap(ctx, GeneratorArgs{
		Name:           "features_test",
		ImageBuffer:    encodePNG(t, terrainImg),
		FeaturesBuffer: encodePNG(t, image.NewNRGBA(image.Rect(0, 0, 8, 8))),
	})
	if err == nil {
		t.Fatal("expected a size mismatch error")
	}
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
