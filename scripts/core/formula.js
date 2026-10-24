export function rollInlineDice(expression = "", random = Math.random) {
  const roll = typeof random === "function" ? random : Math.random;
  return String(expression ?? "").replace(/\b(\d*)d(\d+)\b/gi, (_match, countRaw, sidesRaw) => {
    const count = Math.max(1, Math.min(100, Math.floor(Number(countRaw || 1) || 1)));
    const sides = Math.max(1, Math.min(1000, Math.floor(Number(sidesRaw) || 1)));
    let total = 0;
    for (let index = 0; index < count; index += 1) total += Math.max(1, Math.ceil(roll() * sides));
    return String(total);
  });
}

export function evaluateArithmeticExpression(expression = "") {
  const source = String(expression ?? "");
  let index = 0;

  const skip = () => {
    while (/\s/.test(source[index] ?? "")) index += 1;
  };

  const parseNumber = () => {
    skip();
    const start = index;
    while (/[0-9.]/.test(source[index] ?? "")) index += 1;
    const raw = source.slice(start, index);
    if (!raw || raw === "." || (raw.match(/\./g) ?? []).length > 1) throw new Error("Invalid number");
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error("Invalid number");
    return value;
  };

  const parsePrimary = () => {
    skip();
    const char = source[index] ?? "";
    if (char === "+") {
      index += 1;
      return parsePrimary();
    }
    if (char === "-") {
      index += 1;
      return -parsePrimary();
    }
    if (char === "(") {
      index += 1;
      const value = parseExpression();
      skip();
      if (source[index] !== ")") throw new Error("Missing closing parenthesis");
      index += 1;
      return value;
    }
    return parseNumber();
  };

  const parseTerm = () => {
    let value = parsePrimary();
    while (true) {
      skip();
      const op = source[index] ?? "";
      if (op !== "*" && op !== "/") return value;
      index += 1;
      const right = parsePrimary();
      value = op === "*" ? value * right : value / right;
      if (!Number.isFinite(value)) throw new Error("Invalid arithmetic result");
    }
  };

  function parseExpression() {
    let value = parseTerm();
    while (true) {
      skip();
      const op = source[index] ?? "";
      if (op !== "+" && op !== "-") return value;
      index += 1;
      const right = parseTerm();
      value = op === "+" ? value + right : value - right;
      if (!Number.isFinite(value)) throw new Error("Invalid arithmetic result");
    }
  }

  if (/[^0-9+\-*/().\s]/.test(source)) throw new Error("Unsupported formula token");
  const value = parseExpression();
  skip();
  if (index < source.length) throw new Error("Unexpected formula token");
  return value;
}
