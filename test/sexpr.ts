// source: https://github.com/hatashiro/s-exify
// thanks!

export interface SExp extends Array<string | SExp> {}

export function parse(input: string): SExp {
  let i = 0;

  const impl = () => {
    while (input[i].match(/\s/)) i++; // skip whitespaces
    if (input[i] === "(") {
      // drop '('
      i++;
    } else {
      throw new Error(
        `Input is not valid: unexpected '${input[i]}' at the beginning`
      );
    }

    const result: SExp = [];
    let node = "";

    while (true) {
      let c = input[i++];

      if (!c) {
        if (!node) {
          break;
        } else {
          throw new Error(
            `Input is not valid: unexpected '${node}' at the end`
          );
        }
      }

      if (c === ")") {
        if (node) result.push(node);
        break;
      } else if (c === "\\") {
        c += input[i++];
        node += c;
      } else if (c.match(/\s/)) {
        if (node) result.push(node);
        node = "";
      } else if (c === "(") {
        i--;
        result.push(impl());
      } else if (c === '"') {
        node += c;
        // parse string
        while ((c = input[i++])) {
          // skip \"
          if (c === "\\" && input[i] === '"') {
            c += input[i++];
          }
          node += c;
          if (c === '"') break;
        }
      } else {
        node += c;
      }
    }

    return result;
  };

  return impl();
}

function isString(node: any): node is string {
  return typeof node === "string";
}

export function beautify(input: string | SExp | undefined): string {
    if (input === undefined) {
        return "";
    }

  const sExp = isString(input) ? parse(input) : input;

  const stack: Array<{ idx: number; exp: SExp }> = [{ idx: 0, exp: sExp }];
  let indent = 0;

  let result = "";
  const print = (str: string) => {
    result += "  ".repeat(indent) + str + "\n";
  };

  while (stack.length) {
    const node = stack.pop()!;

    if (node.idx === 0 && node.exp.length < 5 && node.exp.every(isString)) {
      // very short case, just print and it's done
      print(`(${node.exp.join(" ")})`);
      continue;
    }

    let done = false;

    while (true) {
      if (node.idx >= node.exp.length) {
        done = true;
        break;
      }

      const child = node.exp[node.idx++];

      if (node.idx === 1) {
        print(`(${child}`);
        indent++;
      } else if (isString(child)) {
        print(child);
      } else {
        stack.push(node);
        stack.push({ idx: 0, exp: child });
        break;
      }
    }

    if (done) {
      indent--;
      print(")");
    }
  }

  return result.trim();
}