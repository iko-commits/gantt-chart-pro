import nextPlugin from "eslint-plugin-next";
import next from "eslint-config-next";

export default [
  ...next(),
  {
    plugins: {
      next: nextPlugin
    },
    rules: {
      "react/no-unescaped-entities": "off"
    }
  }
];
