import assert = require("assert");
import 'mocha';

describe('This silly test', () => {
    it('should return hello world', () => {
        const result = "hello world";
        assert.strictEqual(result, "hello world");
    });
});
