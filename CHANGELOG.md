### 0.7.5

- Minor adjustments to support tl 0.12.0
- Fix calculation of word ranges
- Fix crash on empty symbols list
- Fix detection of 'tl not found' errors on Windows
- Support both the LuaRocks and standalone versions of tl on Windows

### 0.7.0 - February 16 2021

This release adds support for . and : auto-completions. Also, the server now tries to filter the suggestions depending on context (for instance, function symbols should not appear in the suggestions when typing a type annotation)

### 0.6.3 - February 08 2021

Get rid of `Teal > Compiler Path` setting, as it was misleading and caused some issues (for instance, `LUA_PATH` could take precedence over this setting)

### 0.6.2 - February 08 2021

- Optimize for lower CPU usage
- Fix an off-by-one error which would cause some symbols not to appear in the suggestions

### 0.6.1 - February 07 2021

The extension now displays a warning when `tl --version` < 0.11.0.

### 0.6.0 - February 07 2021

The extension now has basic support for the following LSP features:

- Go to type definition
- Show type on mouse hover
- Simple auto-completion (very early stage!)

### 0.5.4 - February 02 2021

Fix another bug which would cause method calls to be highlighted as type annotations

### 0.5.3 - February 01 2021

More bugfixes related to syntax highlighting:

- Avoid matching method calls as type annotations in some circumstances
- 'do' statements inside 'while' and 'for' bodies should now be matched correctly

### 0.5.1 - January 30 2021

A few bugfixes related to syntax highlighting:

- Fix highlighting of method calls inside table constructors
- Fix handling of comments inside table contructors, function signatures, etc.
- Avoid matching the keyword 'function' inside comments

### 0.5.0 - January 29 2021

- Improved syntax highlighting
- The extension now reports errors detected in tlconfig.lua (instead of failing silently)
- Add `Teal > Compiler Path` setting
- Fix a `tl check` parsing issue which would occur when an error contains two different location markers (such as a "inferred at")

### 0.4.3 - September 22 2020

- Add support for tl v0.8.0

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
