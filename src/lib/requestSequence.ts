export function createRequestSequence() {
  let current = 0;

  return {
    begin() {
      current += 1;
      return current;
    },
    isCurrent(token: number) {
      return token === current;
    },
    invalidate() {
      current += 1;
    },
  };
}
