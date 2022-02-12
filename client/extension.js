/* --------------------------------------------------------------------------------------------
 * Based on lsp-sample.
 * See LICENSE-vscode-extension-samples at the root of the project for licensing info.
 * ------------------------------------------------------------------------------------------ */

const workspace = require("vscode").workspace;
const LanguageClient = require("vscode-languageclient/node").LanguageClient;

let client;

function activate(context) {
	console.log("Starting teal-language-server...");

	let serverExecutableName = "teal-language-server"

	let executable = {
		command: serverExecutableName
	};

	let serverOptions = {
		run: executable,
		debug: executable
	};

	// Options to control the language client
	let clientOptions = {
		// Register the server for .tl files and tlconfig.lua
		documentSelector: [
			{ scheme: 'file', language: 'teal' },
			{ scheme: 'file', language: 'lua', pattern: '**/tlconfig.lua' }
		],
		synchronize: {
			// Notify the server about file changes to .tl and .lua files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/*.{tl,lua}')
		},
		outputChannelName: 'Teal Language Server'
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'TealLanguageServer',
		'Teal Language Server',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();
}

function deactivate() {
	if (!client) {
		return undefined;
	}

	return client.stop();
}

module.exports = {
	activate: activate,
	deactivate: deactivate
};
