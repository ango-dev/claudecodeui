import { PrismLight } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import batch from 'react-syntax-highlighter/dist/esm/languages/prism/batch';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import clike from 'react-syntax-highlighter/dist/esm/languages/prism/clike';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import dart from 'react-syntax-highlighter/dist/esm/languages/prism/dart';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker';
import elixir from 'react-syntax-highlighter/dist/esm/languages/prism/elixir';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import graphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql';
import groovy from 'react-syntax-highlighter/dist/esm/languages/prism/groovy';
import haskell from 'react-syntax-highlighter/dist/esm/languages/prism/haskell';
import hcl from 'react-syntax-highlighter/dist/esm/languages/prism/hcl';
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import json5 from 'react-syntax-highlighter/dist/esm/languages/prism/json5';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';
import less from 'react-syntax-highlighter/dist/esm/languages/prism/less';
import lua from 'react-syntax-highlighter/dist/esm/languages/prism/lua';
import makefile from 'react-syntax-highlighter/dist/esm/languages/prism/makefile';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import nginx from 'react-syntax-highlighter/dist/esm/languages/prism/nginx';
import objectivec from 'react-syntax-highlighter/dist/esm/languages/prism/objectivec';
import perl from 'react-syntax-highlighter/dist/esm/languages/prism/perl';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import powershell from 'react-syntax-highlighter/dist/esm/languages/prism/powershell';
import properties from 'react-syntax-highlighter/dist/esm/languages/prism/properties';
import protobuf from 'react-syntax-highlighter/dist/esm/languages/prism/protobuf';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import r from 'react-syntax-highlighter/dist/esm/languages/prism/r';
import regex from 'react-syntax-highlighter/dist/esm/languages/prism/regex';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import scala from 'react-syntax-highlighter/dist/esm/languages/prism/scala';
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss';
import solidity from 'react-syntax-highlighter/dist/esm/languages/prism/solidity';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import vim from 'react-syntax-highlighter/dist/esm/languages/prism/vim';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import zig from 'react-syntax-highlighter/dist/esm/languages/prism/zig';

/**
 * The syntax highlighter chat code blocks render through.
 *
 * `react-syntax-highlighter`'s default Prism export bundles every language
 * Prism ships — around 290 of them. That is roughly a quarter of the app's
 * JavaScript, and registering them costs a depth-first walk of the whole
 * grammar table on startup, which profiles as the single most expensive thing
 * the client does before it can paint.
 *
 * These are the languages a coding agent actually emits fences for. Anything
 * outside the list still renders — refractor throws on an unknown grammar and
 * the highlighter falls back to plain text — it simply is not coloured. Each
 * grammar registers its own aliases, so `sh`, `yml`, `py` and friends resolve
 * without being listed separately.
 */
const LANGUAGES = {
  bash, batch, c, clike, cpp, csharp, css, dart, diff, docker, elixir, go,
  graphql, groovy, haskell, hcl, ini, java, javascript, json, json5, jsx,
  kotlin, less, lua, makefile, markdown, markup, nginx, objectivec, perl, php,
  powershell, properties, protobuf, python, r, regex, ruby, rust, scala, scss,
  solidity, sql, swift, toml, tsx, typescript, vim, yaml, zig,
};

for (const [name, language] of Object.entries(LANGUAGES)) {
  PrismLight.registerLanguage(name, language);
}

export const SyntaxHighlighter = PrismLight;

type PrismTheme = typeof oneLight;

/**
 * Swaps every colour of a Prism theme through `colorMap` (exact source value →
 * replacement). `hsla(h, s, l, a)` values are matched by their `hsla(h, s, l,`
 * prefix so the alpha survives. Values without a mapped colour are kept as is.
 */
function recolorPrismTheme(theme: PrismTheme, colorMap: Record<string, string>): PrismTheme {
  const recolored: PrismTheme = {};
  for (const [selector, rule] of Object.entries(theme)) {
    const recoloredRule: Record<string, unknown> = {};
    for (const [property, value] of Object.entries(rule)) {
      recoloredRule[property] = typeof value === 'string'
        ? Object.entries(colorMap).reduce((current, [from, to]) => current.split(from).join(to), value)
        : value;
    }
    recolored[selector] = recoloredRule as PrismTheme[string];
  }
  return recolored;
}

// One Light, re-tinted to the warm theme: cool grays become warm grays, keywords
// take the clay accent, and every token colour keeps 4.5:1 on the code block.
const WARM_LIGHT_COLORS: Record<string, string> = {
  'hsl(230, 1%, 98%)': 'hsl(48, 33%, 97%)',
  'hsl(230, 8%, 24%)': 'hsl(40, 6%, 20%)',
  'hsla(230, 8%, 24%,': 'hsla(40, 6%, 20%,',
  'hsl(230, 1%, 90%)': 'hsl(45, 22%, 88%)',
  'hsl(230, 4%, 64%)': 'hsl(40, 6%, 40%)',
  'hsl(35, 99%, 36%)': 'hsl(30, 85%, 30%)',
  'hsl(301, 63%, 40%)': 'hsl(15, 58%, 40%)',
  'hsl(5, 74%, 59%)': 'hsl(350, 52%, 40%)',
  'hsl(119, 34%, 47%)': 'hsl(85, 40%, 28%)',
  'hsl(221, 87%, 60%)': 'hsl(210, 45%, 36%)',
  'hsl(198, 99%, 37%)': 'hsl(180, 45%, 26%)',
  'hsl(344, 84%, 43%)': 'hsl(345, 60%, 38%)',
  'hsl(230, 6%, 44%)': 'hsl(40, 5%, 36%)',
  'hsl(230, 1%, 78%)': 'hsl(44, 15%, 78%)',
  'hsl(230, 1%, 62%)': 'hsl(40, 5%, 40%)',
  'hsl(0, 0, 95%)': 'hsl(45, 20%, 92%)',
};

// One Dark on a warm charcoal: same token roles, softened warm hues.
const WARM_DARK_COLORS: Record<string, string> = {
  'hsl(220, 13%, 18%)': 'hsl(30, 3%, 12%)',
  'hsl(220, 14%, 71%)': 'hsl(42, 15%, 82%)',
  'hsla(220, 14%, 71%,': 'hsla(42, 15%, 82%,',
  'hsl(220, 13%, 28%)': 'hsl(40, 4%, 28%)',
  'hsl(220, 10%, 40%)': 'hsl(40, 7%, 60%)',
  'hsl(29, 54%, 61%)': 'hsl(32, 62%, 66%)',
  'hsl(286, 60%, 67%)': 'hsl(15, 68%, 68%)',
  'hsl(355, 65%, 65%)': 'hsl(355, 50%, 72%)',
  'hsl(95, 38%, 62%)': 'hsl(80, 32%, 64%)',
  'hsl(207, 82%, 66%)': 'hsl(205, 50%, 72%)',
  'hsl(187, 47%, 55%)': 'hsl(175, 32%, 60%)',
  'hsl(5, 48%, 51%)': 'hsl(5, 50%, 66%)',
  'hsl(220, 13%, 26%)': 'hsl(40, 4%, 26%)',
  'hsl(220, 9%, 55%)': 'hsl(40, 7%, 62%)',
  'hsla(220, 100%, 80%,': 'hsla(40, 30%, 80%,',
  'hsl(220, 14%, 45%)': 'hsl(40, 6%, 56%)',
  'hsl(224, 13%, 17%)': 'hsl(30, 3%, 12%)',
  'hsl(219, 13%, 22%)': 'hsl(40, 3%, 18%)',
};

/** Light-mode Prism theme in the app's warm palette; used by chat and code-editor markdown code blocks. */
export const warmPrismLight = recolorPrismTheme(oneLight, WARM_LIGHT_COLORS);

/** Dark-mode Prism theme in the app's warm palette; used by chat and code-editor markdown code blocks. */
export const warmPrismDark = recolorPrismTheme(oneDark, WARM_DARK_COLORS);
