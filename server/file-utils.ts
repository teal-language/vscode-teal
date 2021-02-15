import { access as fsAccess, constants as fsConstants } from 'fs';
import { promisify } from "util";

export function fileExists(filePath: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        fsAccess(filePath, fsConstants.F_OK, function (error) {
            resolve(error === null);
        });
    });
}

export const writeFile = promisify(require("fs").write);
