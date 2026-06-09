let SkyholdAppClass = null;

export function registerSkyholdAppClass(cls) {
  SkyholdAppClass = cls;
}

export function getSkyholdAppClass() {
  return SkyholdAppClass;
}

export function getSkyholdManager() {
  return SkyholdAppClass?.instance ?? null;
}
