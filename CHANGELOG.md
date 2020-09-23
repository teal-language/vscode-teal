### 0.4.3 - September 22 2020

- Add support for Teal v0.8.0

### 0.4.2 - June 30 2020

- Diagnostics should now be correctly associated with the file that produced the error (thanks factubsio) 

### 0.4.1 - May 13 2020

- The extension will now run `tl check` on .tl files when a plain .lua file is modified. This means that changes to tlconfig.lua are now acknowledged as soon as the file is saved.

### 0.4.0 - Apr 29 2020

- Fix Windows support (thanks Nebulavenus)
- Automatic indentation fixes
- Validate all open documents when a TL file changes

### 0.3.0 - Apr 25 2020

Add the root of the workspace to LUA_PATH when running `tl check`.

### 0.2.0 - Mar 23 2020

Add some basic snippets.

### 0.1.2 - Mar 23 2020

Update the repository's URL.

### 0.1.1 - Mar 23 2020

Improve error handling in the language server.

### 0.1.0 - Mar 23 2020

Initial release. The extension supports `tl check` and some basic syntax highlighting.
