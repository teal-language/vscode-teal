export class MajorMinorPatch {
    major: number
    minor: number
    patch: number

    constructor(major: number, minor: number, patch: number) {
        this.major = major;
        this.minor = minor;
        this.patch = patch;
    }

    compareTo(v: MajorMinorPatch): number {
        if (this.major > v.major) return 1;
        if (this.major < v.major) return -1;

        if (this.minor > v.minor) return 1;
        if (this.minor < v.minor) return -1;

        if (this.patch > v.patch) return 1;
        if (this.patch < v.patch) return -1;

        return 0;
    }

    toString(): string {
        return `${this.major}.${this.minor}.${this.patch}`;
    }
}
