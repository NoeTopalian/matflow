export function filterTodoItems<T extends { count: number }>(items: T[]): T[] {
  return items.filter((item) => item.count > 0);
}
