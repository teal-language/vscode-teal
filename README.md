# Teal for Visual Studio Code

[![Node.js CI](https://img.shields.io/github/workflow/status/teal-language/vscode-teal/Node.js%20CI.svg?logo=github)](https://github.com/teal-language/vscode-teal/actions?query=workflow%3A%22Node.js+CI%22)

Provides IntelliSense and syntax highlighting for [Teal](https://github.com/teal-language/tl) in Visual Studio Code.

## Requirements

Make sure that the Teal compiler (v0.12.0 or later) is available in your PATH:
```
luarocks install tl
```

## Installing

Download this extension from the [VS Code Extension Marketplace](https://marketplace.visualstudio.com/items?itemName=pdesaulniers.vscode-teal) or the [Open VSX Registry](https://open-vsx.org/extension/pdesaulniers/vscode-teal).

## Snippets

Trigger | Name | Body
--- | --- | ---
req | Local require | local name = require("module")
loc | Local variable | local name = value
fori | ipairs loop | for k, v in ipairs(sequence) do ... end
forp | pairs loop | for k, v in pairs(table) do ... end
lrec | Local record definition | local record name ... end
grec | Global record definition | global record name ... end
lenu | Local enum definition | local enum name ... end
genu | Global enum definition | global enum name ... end

## FAQ

### 'Module not found' errors

By default, this extension runs `tl check` at the root of the workspace.

If your code resides in subdirectories (such as `src/` or `lib/`), you need to add the directories to `tlconfig.lua` at the root of the workspace:
```lua
return {
    include_dir = {
        "src/",
        "lib/"
    }
}
```

### [Error] messages at the bottom right of the screen

Make sure you are using the latest version of the `tl` compiler. If upgrading `tl` does not fix the problem, then please [create an issue](https://github.com/teal-language/vscode-teal/issues/new).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Contributors

Contributions are greatly appreciated! Feel free to fork [this repository](https://github.com/teal-language/vscode-teal) and open a pull request on GitHub.
