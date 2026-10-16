/** Short tags for the scoring methods, shown inside the card flags (the colour carries the class). */
const TAGS: Record<string, string> = { cpu: "CPU", resnet18: "R18", resnet50: "R50" };

export const methodTag = (method: string): string => TAGS[method] ?? method.toUpperCase();
