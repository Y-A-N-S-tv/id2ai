# id2ai

Converts an InDesign file (`.indd` or `.idml`) to an Illustrator file (`.ai`).

It exports each InDesign layer of each page as a live-transparency PDF with bleed, then rebuilds the same layers and artboards in Illustrator.

## Requirements

- Adobe InDesign and Adobe Illustrator
- Node.js
- macOS or Windows

## Usage

```
node id2ai.js <input.indd|input.idml> [output.ai]
```

Options:

- `--debug` keeps the intermediate files
- `--help`, `-h` shows the help

## Licence

MIT. See [LICENSE](LICENSE).
