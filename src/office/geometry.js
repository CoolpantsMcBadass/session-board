// The floorplan, traced off the drawing once and then left alone.
//
// This is a .js rather than the .json it was authored as because the renderer
// is loaded over file://, where fetch() is blocked by Chromium and fails
// silently enough to look like a styling bug. A script tag always works, and
// the board has no build step to generate one from the other, so the JS is the
// single source and the JSON is gone rather than left behind to drift.
window.OfficeGeometry = {
  "artInkBox": [
    148,
    549,
    1183,
    2340
  ],
  "inkSize": [
    1035,
    1791
  ],
  "offices": [
    {
      "id": 1,
      "rect": [
        0.0232,
        0.0123,
        0.5246,
        0.2557
      ]
    },
    {
      "id": 2,
      "rect": [
        0.5333,
        0.0123,
        0.9614,
        0.2792
      ]
    },
    {
      "id": 3,
      "rect": [
        0.6396,
        0.282,
        0.9614,
        0.4846
      ]
    },
    {
      "id": 4,
      "rect": [
        0.6396,
        0.4858,
        0.9614,
        0.7247
      ]
    },
    {
      "id": 5,
      "rect": [
        0.6357,
        0.7259,
        0.9614,
        0.8671
      ]
    }
  ],
  "spareRoom": [
    0.715,
    0.8693,
    0.9614,
    0.9838
  ],
  "table": {
    "shape": "stadium",
    "rect": [
      0.16,
      0.455,
      0.466,
      0.742
    ]
  },
  "wallPanel": [
    0.5333,
    0.2122,
    0.628,
    0.258
  ],
  "openings": [
    {
      "office": 1,
      "axis": "h",
      "x": 0.4802,
      "y": 0.2574,
      "span": 0.0918
    },
    {
      "office": 2,
      "axis": "v",
      "x": 0.6329,
      "y": 0.2697,
      "span": 0.0235
    },
    {
      "office": 3,
      "axis": "v",
      "x": 0.6329,
      "y": 0.3417,
      "span": 0.0251
    },
    {
      "office": 4,
      "axis": "v",
      "x": 0.6329,
      "y": 0.7046,
      "span": 0.0642
    },
    {
      "office": 5,
      "axis": "v",
      "x": 0.6329,
      "y": 0.7984,
      "span": 0.0279
    }
  ]
};
