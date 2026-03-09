import * as JsYaml from '../vendor/js-yaml.mjs';

export const parseYaml = <T = unknown>(input: string): T => {
  return JsYaml.load(input) as T;
};

export const stringifyYaml = (input: unknown): string => {
  return JsYaml.dump(input, {
    noRefs: true,
    lineWidth: 120,
    quotingType: '"',
  });
};
