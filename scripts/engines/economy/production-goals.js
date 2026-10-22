const whole = (value) => Math.max(0, Math.floor(Number(value) || 0));

/** A fresh tracker belongs to one simulated tenday, never to a saved batch. */
export function createProductionGoalTracker(goalForLine = () => null) {
  const preparedByLine = new Map();
  const goal = (building, line) => {
    const value = goalForLine(building, line);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  return {
    goal,
    prepared: (line) => preparedByLine.get(line) ?? 0,
    remaining(building, line) {
      const target = goal(building, line);
      return target === null ? null : Math.max(0, target - (preparedByLine.get(line) ?? 0));
    },
    complete(line, qty) {
      preparedByLine.set(line, (preparedByLine.get(line) ?? 0) + whole(qty));
    }
  };
}
