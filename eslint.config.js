import stylistic from '@stylistic/eslint-plugin';
import { configs as airbnbConfigs, plugins as airbnbPlugins } from 'eslint-config-airbnb-extended';
import prettier from 'eslint-config-prettier';
import jsdocPlugin from 'eslint-plugin-jsdoc';
import pkgJsonPlugin from 'eslint-plugin-package-json';
import unusedImportsPlugin from 'eslint-plugin-unused-imports';
import globals from 'globals';

export default [
  { ignores: ['.wrangler/', 'coverage/', 'node_modules/'] },

  // Register the plugins and apply the Airbnb rules to all files, without their `files` restriction.
  // Use our own @stylistic instead of the older version bundled with Airbnb, which can't be
  // registered twice
  { name: airbnbPlugins.stylistic.name, plugins: { '@stylistic': stylistic } },
  (({ files: _f, ...c }) => c)(airbnbPlugins.importX),
  ...airbnbConfigs.base.recommended.map(({ files: _f, ...c }) => c),

  // Disable rules that conflict with Prettier
  prettier,

  jsdocPlugin.configs['flat/recommended'],

  pkgJsonPlugin.configs['recommended-publishable'],
  pkgJsonPlugin.configs.stylistic,

  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.es2025,
        ...globals.node,
        // Workers runtime types, used in JSDoc
        D1Database: 'readonly',
        DurableObjectState: 'readonly',
        D1PreparedStatement: 'readonly',
        DurableObjectStub: 'readonly',
        WebSocketPair: 'readonly',
      },
    },
    plugins: {
      'unused-imports': unusedImportsPlugin,
      jsdoc: jsdocPlugin,
    },
    rules: {
      'class-methods-use-this': 'off',
      'import-x/extensions': 'off',
      'import-x/no-extraneous-dependencies': 'off',
      'import-x/no-unresolved': 'off',
      // Workers resolve ES modules by their full path, without directory index lookups
      'import-x/no-useless-path-segments': 'off',
      'import-x/prefer-default-export': 'off',
      'import-x/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'object',
            'type',
            'internal',
            'parent',
            'sibling',
            'index',
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'sort-imports': [
        'error',
        {
          allowSeparatedGroups: true,
          ignoreCase: true,
          ignoreDeclarationSort: true,
          ignoreMemberSort: false,
          memberSyntaxSortOrder: ['none', 'all', 'multiple', 'single'],
        },
      ],
      'unused-imports/no-unused-imports': 'error',
      'jsdoc/no-undefined-types': 'off',
      'jsdoc/reject-any-type': 'off',
      'jsdoc/require-jsdoc': [
        'warn',
        {
          require: {
            ArrowFunctionExpression: true,
            ClassDeclaration: true,
            ClassExpression: true,
            FunctionDeclaration: true,
            FunctionExpression: true,
            MethodDefinition: true,
          },
        },
      ],
      'jsdoc/check-indentation': 1,
      'jsdoc/check-line-alignment': 1,
      'jsdoc/check-syntax': 1,
      'jsdoc/match-description': 1,
      'jsdoc/no-bad-blocks': 1,
      'jsdoc/no-blank-block-descriptions': 1,
      'jsdoc/no-defaults': 1,
      'jsdoc/require-asterisk-prefix': 1,
      'jsdoc/require-description': 1,
      'jsdoc/require-description-complete-sentence': ['error', { abbreviations: ['e.g.'] }],
      'jsdoc/require-hyphen-before-param-description': [
        'error',
        'never',
        { tags: { property: 'never' } },
      ],
      'jsdoc/require-throws': 1,
      'jsdoc/sort-tags': 1,
    },
  },

  // Tests don’t need documentation for every callback
  {
    files: ['**/*.test.js'],
    rules: {
      'jsdoc/require-jsdoc': 'off',
    },
  },
];
