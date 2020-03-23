# Teal for Visual Studio Code

[![Node.js CI](https://img.shields.io/github/workflow/status/teal-language/vscode-teal/Node.js%20CI.svg?logo=github)](https://github.com/teal-language/vscode-teal/actions?query=workflow%3A%22Node.js+CI%22)

Provides a language server and syntax highlighting for [Teal](https://github.com/teal-language/tl) in Visual Studio Code.

## Features

- Syntax highlighting
- Error checking
- Snippets

## Requirements

Make sure that the Teal compiler is available in your PATH:
```
luarocks install tl
```

## Installing

This extension is available in the [VS Code Extension Marketplace](https://marketplace.visualstudio.com/items?itemName=pdesaulniers.vscode-teal).

## Snippets

Trigger | Name | Body
--- | --- | ---
req | Local require | local name = require("module")
loc | Local variable | local name = value
fori | ipairs loop | for k, v in ipairs(sequence) do ... end
forp | pairs loop | for k, v in pairs(sequence) do ... end
lrec | Local record definition | local name = record ... end
grec | Global record definition | global name = record ... end
lenu | Local enum definition | local name = enum ... end
genu | Global enum definition | global name = enum ... end

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes.
