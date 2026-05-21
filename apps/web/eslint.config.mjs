import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextVitals,
  {
    rules: {
      "react-hooks/set-state-in-effect": "off"
    }
  },
  {
    ignores: [".next/**", "node_modules/**", "coverage/**"]
  }
];

export default eslintConfig;
