const rules = {
  'no-void': ["error", { "allowAsStatement": true }],
  'dot-notation': ['off'],
  'sort-keys': ['off'],
}

module.exports = {
  extends: '@chatie',
  rules,
  "globals": {
    "NodeJS": true
  },
}
