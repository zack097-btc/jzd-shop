# Third-party files in this folder

Everything here is used by the VIN scanner and the shop phone, runs on the
device, and makes no network requests of its own. Each file is copied
unchanged from the npm package named, at the version named.

| File | Package | Version | Licence |
|---|---|---|---|
| `zxing-reader.js`, `zxing_reader.wasm` | `zxing-wasm` (zxing-cpp compiled to WebAssembly) | 2.2.4 | MIT (wrapper); zxing-cpp is Apache-2.0 |
| `tesseract.min.js`, `tesseract-worker.min.js` | `tesseract.js` | 6.0.1 | Apache-2.0 (bundles MIT and BSD-3-Clause helpers, noted in the files) |
| `tesseract-core-simd-lstm.wasm.js`, `tesseract-core-lstm.wasm.js` | `tesseract.js-core` (Tesseract OCR and Leptonica compiled to WebAssembly) | 6.1.2 | Apache-2.0; Leptonica is under its own BSD-style licence; zlib, libpng and libjpeg under their permissive licences |
| `eng.traineddata.gz` | `@tesseract.js-data/eng` (`4.0.0_best_int`, from tesseract-ocr/tessdata) | 1.0.0 | MIT (package); the trained data is Apache-2.0 |
| `qrcode.js` | `qrcode-generator` (Kazuhiko Arase) | 1.4.4 | MIT |

The phone shell's crypto (`desktop/shophub/src/noble.js`) is the noble
libraries by Paul Miller, MIT.

None of these is GPL, LGPL or AGPL.
