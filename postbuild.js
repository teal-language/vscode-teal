const fs = require('fs');
const path = require('path');

// Move .wasm file into out/ directory

const wasmFileName = "tree-sitter-teal.wasm";
const oldPath = path.resolve(__dirname, wasmFileName);
const newPath = path.resolve(__dirname, "out", wasmFileName);

fs.renameSync(oldPath, newPath);
