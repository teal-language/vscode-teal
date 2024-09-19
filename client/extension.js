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

	let clientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'teal' },
			{ scheme: 'file', language: 'lua', pattern: '**/tlconfig.lua' }
		],
		synchronize: {
			fileEvents: workspace.createFileSystemWatcher('**/*.{tl,lua}')
		},
		outputChannelName: 'Teal Language Server'
	};

	client = new LanguageClient(
		'TealLanguageServer',
		'Teal Language Server',
		serverOptions,
		clientOptions
	);

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
