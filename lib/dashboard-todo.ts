export type TodoItem = {
  label: string;
  count: number;
  Icon: React.ElementType;
  color: string;
  href: string;
  action: string;
};

export function filterTodoItems<T extends { count: number }>(items: T[]): T[] {
  return items.filter((item) => item.count > 0);
}
