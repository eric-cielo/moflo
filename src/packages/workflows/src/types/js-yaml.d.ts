declare module 'js-yaml' {
  export function load(input: string, options?: object): unknown;
  export function dump(input: unknown, options?: object): string;
}
