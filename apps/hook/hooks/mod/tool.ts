/**
 * The `plannotator` tool's contract, as the Claude Code mod registers it
 * (`$.tool.register` in register.ts).
 *
 * A COPY of packages/shared/plannotator-tool.ts: a hooks module may import
 * only its own folder. Everything below the CONTRACT marker must stay byte
 * for byte the same as there; `tool.test.ts` fails when they differ. Edit the
 * shared file, then paste its contract section here.
 */

// --- CONTRACT (copied verbatim into apps/hook/hooks/mod/tool.ts) ---

export const PLANNOTATOR_TOOL_NAME = 'plannotator'

export type PlannotatorToolAction = 'annotate' | 'review' | 'last'

export interface PlannotatorToolInput {
  action: PlannotatorToolAction
  target?: string
  gate?: boolean
  options?: { base?: string; markdown?: boolean }
}

export const PLANNOTATOR_TOOL_DESCRIPTION = [
  'Open Plannotator, the browser review UI, for the user, and return at once.',
  '- action "annotate": annotate a file (markdown, text, config, HTML), a folder, or a URL; `target` is required. `gate: true` adds an Approve button for an explicit sign-off. `options.markdown: true` converts HTML or a URL to markdown first.',
  '- action "review": review code changes; `target` is an optional repository directory or a GitHub/GitLab/Bitbucket pull request URL (default: the current repository). `options.base` sets the compare branch or ref (git only).',
  '- action "last": annotate your own last assistant message; no target.',
  'The call only opens the page. The reviewer\'s feedback arrives later as a message from the plannotator plugin, so end your turn after calling this and wait for it. Use this tool instead of running the `plannotator` CLI. Plan review is not done with this tool: it opens by itself when you exit plan mode.',
].join('\n')

export const PLANNOTATOR_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['annotate', 'review', 'last'],
      description: 'What to open: annotate a file/folder/URL, review code changes or a PR, or annotate your last message.',
    },
    target: {
      type: 'string',
      description: 'annotate: the file, folder or URL (required). review: a repository directory or PR URL (optional). last: not used.',
    },
    gate: {
      type: 'boolean',
      description: 'annotate only: show an Approve button so the reviewer can sign off explicitly.',
    },
    options: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'review only: the branch or ref to compare against (git).' },
        markdown: { type: 'boolean', description: 'annotate only: convert an HTML file or URL to markdown before annotating.' },
      },
      additionalProperties: false,
    },
  },
  required: ['action'],
  additionalProperties: false,
} as const

/** Longest target or base accepted; a real path or URL is far shorter. */
export const PLANNOTATOR_TOOL_MAX_TEXT = 4096

const TOOL_KEYS = ['action', 'target', 'gate', 'options']
const OPTION_KEYS = ['base', 'markdown']

export type PlannotatorToolParse = { ok: true; input: PlannotatorToolInput } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A string the CLI can take as one argument: no control characters, never read as a flag. */
function checkWord(name: string, value: unknown): string | null {
  if (typeof value !== 'string') return `${name} must be a string`
  if (value.trim() === '') return `${name} must not be empty`
  if (value.length > PLANNOTATOR_TOOL_MAX_TEXT) return `${name} is longer than ${PLANNOTATOR_TOOL_MAX_TEXT} characters`
  if (/[\u0000-\u001f\u007f]/.test(value)) return `${name} must not contain control characters or line breaks`
  if (value.trim().startsWith('-')) return `${name} must not start with "-"`
  return null
}

/**
 * Validates a tool call strictly: unknown keys, wrong types, and a field the
 * action does not take are errors (a `false` the action ignores is allowed,
 * since models often fill defaults). The error text is for the model.
 */
export function parsePlannotatorToolInput(value: unknown): PlannotatorToolParse {
  const fail = (error: string): PlannotatorToolParse => ({ ok: false, error: `Invalid plannotator call: ${error}.` })
  if (!isRecord(value)) return fail('the input must be an object')
  for (const key of Object.keys(value)) {
    if (!TOOL_KEYS.includes(key)) return fail(`unknown field "${key}"`)
  }
  const action = value.action
  if (action !== 'annotate' && action !== 'review' && action !== 'last') {
    return fail('action must be "annotate", "review" or "last"')
  }
  const input: PlannotatorToolInput = { action }

  if (value.target !== undefined) {
    if (action === 'last') return fail('action "last" takes no target')
    const problem = checkWord('target', value.target)
    if (problem) return fail(problem)
    input.target = (value.target as string).trim()
  } else if (action === 'annotate') {
    return fail('action "annotate" needs a target (a file, folder or URL)')
  }

  if (value.gate !== undefined) {
    if (typeof value.gate !== 'boolean') return fail('gate must be true or false')
    if (value.gate && action !== 'annotate') return fail('gate is for action "annotate" only')
    if (value.gate) input.gate = true
  }

  if (value.options !== undefined) {
    const options = value.options
    if (!isRecord(options)) return fail('options must be an object')
    for (const key of Object.keys(options)) {
      if (!OPTION_KEYS.includes(key)) return fail(`unknown option "${key}"`)
    }
    const parsed: NonNullable<PlannotatorToolInput['options']> = {}
    if (options.base !== undefined) {
      if (action !== 'review') return fail('options.base is for action "review" only')
      const problem = checkWord('options.base', options.base)
      if (problem) return fail(problem)
      if (/\s/.test((options.base as string).trim())) return fail('options.base must not contain spaces')
      parsed.base = (options.base as string).trim()
    }
    if (options.markdown !== undefined) {
      if (typeof options.markdown !== 'boolean') return fail('options.markdown must be true or false')
      if (options.markdown && action !== 'annotate') return fail('options.markdown is for action "annotate" only')
      if (options.markdown) parsed.markdown = true
    }
    if (Object.keys(parsed).length > 0) input.options = parsed
  }

  return { ok: true, input }
}

/**
 * The arguments the matching slash command would carry (`/plannotator-annotate
 * <these>`), one argument per element, never re-split. `last` has none.
 */
export function plannotatorToolArgs(input: PlannotatorToolInput): string[] {
  switch (input.action) {
    case 'annotate':
      return [
        input.target ?? '',
        ...(input.gate ? ['--gate'] : []),
        ...(input.options?.markdown ? ['--markdown'] : []),
      ]
    case 'review':
      return [
        ...(input.options?.base ? ['--base', input.options.base] : []),
        ...(input.target ? [input.target] : []),
      ]
    case 'last':
      return []
  }
}

/** The tool's result once the session is open (`url`) or still starting (no url). */
export function plannotatorToolOpenedText(subject: string, url: string | undefined, gate: boolean): string {
  const where = url ? `Opened ${subject} in Plannotator: ${url}` : `Plannotator is starting for ${subject}; it opens in the browser when ready.`
  const outcome = gate
    ? 'If they approve, an approval message arrives; if they send annotations, the feedback arrives. Closing it sends nothing.'
    : 'When they send annotations, the feedback arrives. Closing it with nothing to send sends nothing.'
  return [
    where,
    'The reviewer is looking at it now. End your turn now and wait: their decision arrives later as a message from the plannotator plugin.',
    outcome,
    'Do not poll, reopen it, or run the plannotator CLI for this session.',
  ].join('\n')
}

/**
 * The words of `command` when it is ONE simple command a shell would run
 * without interpreting anything; null otherwise.
 *
 * Quoting follows the slash commands' splitter (`splitShellWords`): whitespace
 * separates, single quotes are literal, double quotes group (a backslash
 * escapes `"`, `\`, `$` and a backtick inside them), a backslash outside quotes
 * escapes the next character. Where that splitter tolerates, this refuses:
 * anything the shell would expand or treat as syntax makes the result null, so
 * a word here is exactly the argument the program would have received. That
 * is: an unquoted operator or redirect (`; & | < > ( )`), a line break, `$`
 * or a backtick outside single quotes, an unquoted glob or brace (`* ? [ { }`),
 * a `#` that starts a word (a comment), a `~` that starts a word other than
 * `~` or `~/...` (the CLIs expand those two themselves), and an unterminated
 * quote.
 */
export function simpleShellCommandWords(command: string): string[] | null {
  const input = command.trim()
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string

    if (quote === "'") {
      if (char === "'") quote = null
      else word += char
      continue
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null
      } else if (char === '\\' && index + 1 < input.length && '"\\$`'.includes(input[index + 1] as string)) {
        word += input[index + 1]
        index += 1
      } else if (char === '$' || char === '`') {
        return null
      } else {
        word += char
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      inWord = true
      continue
    }

    if (char === '\\' && index + 1 < input.length) {
      // A backslash before a line break joins lines: not one simple word.
      if (input[index + 1] === '\n' || input[index + 1] === '\r') return null
      word += input[index + 1]
      inWord = true
      index += 1
      continue
    }

    if (char === '\n' || char === '\r') return null

    if (/\s/.test(char)) {
      if (inWord) {
        words.push(word)
        word = ''
        inWord = false
      }
      continue
    }

    if (';&|<>()$`*?[{}'.includes(char)) return null
    if (!inWord && char === '#') return null
    if (!inWord && char === '~') {
      const after = input[index + 1]
      if (after !== undefined && after !== '/' && !/\s/.test(after)) return null
    }

    word += char
    inWord = true
  }

  if (quote) return null
  if (inWord) words.push(word)
  return words
}

/**
 * Annotate flags for a script that reads the CLI's own channels: the exit
 * code and stdout record of a strict gate (`--require-approval`,
 * `--result-file`) or the hook-shaped stdout (`--hook`). A host that starts
 * the CLI detached and delivers the decision later as a message has no caller
 * reading any of them, so the reviewer's decision would be lost. Such a host
 * refuses annotate words carrying one (`scriptOnlyAnnotateFlag`), and the
 * shell take-over below leaves a command carrying one to run as written.
 */
export const SCRIPT_ONLY_ANNOTATE_FLAGS: readonly string[] = ['--require-approval', '--result-file', '--hook']

/** The first script-only annotate flag among the words, or null. */
export function scriptOnlyAnnotateFlag(words: readonly string[]): string | null {
  return words.find((word) => SCRIPT_ONLY_ANNOTATE_FLAGS.includes(word)) ?? null
}

/** What a detached host answers when the user's annotate words carry a script-only flag. */
export function scriptOnlyAnnotateFlagText(flag: string): string {
  return (
    `Plannotator did not open: ${flag} is for scripts that read the CLI's exit code or result file, ` +
    'and here your decision comes back as a message instead, so nothing would read it. ' +
    `Run \`plannotator annotate <file> --gate --json ${flag === '--result-file' ? '--result-file <path>' : flag}\` in a terminal, ` +
    `or drop ${SCRIPT_ONLY_ANNOTATE_FLAGS.join(' / ')} to annotate here.`
  )
}

const COMMAND_ACTIONS: Record<string, PlannotatorToolAction> = {
  annotate: 'annotate',
  review: 'review',
  'annotate-last': 'last',
  last: 'last',
}

/**
 * An agent's shell command (a Bash tool call) as the `plannotator` tool call
 * that opens the same thing, or null when the command is not one to take over.
 *
 * A host that can deliver decisions later answers such a command itself,
 * through the same launch as the tool, instead of running the blocking CLI:
 * the agent gets the tool's experience (the page opens, the turn ends, the
 * decision arrives as a message, Ask AI asks this session) even when it reached
 * for the CLI.
 *
 * Taken over: one simple command (see `simpleShellCommandWords`) whose first
 * word is exactly `plannotator` (the installed binary on PATH; a path such as
 * `./plannotator` is a dev build and runs for real), with subcommand
 * `annotate`, `review`, `annotate-last` or `last`, carrying only what the tool
 * represents: annotate `<target>` plus `--gate` and `--markdown`; review
 * `[target]` plus `--base <ref>`; last with no arguments. `--json` is accepted
 * and dropped (the decision arrives as a message, not on stdout). The result
 * passes `parsePlannotatorToolInput`.
 *
 * Everything else is null and runs as written: other subcommands, any other
 * flag (`--require-approval`, `--result-file`, `--hook`, `--tailscale`,
 * `--static`, `--app`, `--no-jina`, `--help`, ...), a repeated flag, more than
 * one target, an environment prefix, and any shell syntax (`cd x && ...`,
 * pipes, redirects, substitutions), so scripted strict gates keep the CLI.
 */
export function plannotatorCommandToToolInput(command: string): PlannotatorToolInput | null {
  const words = simpleShellCommandWords(command)
  if (!words || words.length < 2) return null
  const program = words[0] as string
  if (program !== 'plannotator') return null
  const action = COMMAND_ACTIONS[words[1] as string]
  if (!action) return null

  const seen = new Set<string>()
  const targets: string[] = []
  const call: Record<string, unknown> = { action }
  const options: Record<string, unknown> = {}
  const rest = words.slice(2)
  if (scriptOnlyAnnotateFlag(rest)) return null
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] as string
    if (!word.startsWith('-')) {
      targets.push(word)
      continue
    }
    if (seen.has(word)) return null
    seen.add(word)
    if (word === '--json') continue
    if (word === '--gate' && action === 'annotate') call.gate = true
    else if (word === '--markdown' && action === 'annotate') options.markdown = true
    else if (word === '--base' && action === 'review') {
      const value = rest[index + 1]
      if (value === undefined || value.startsWith('-')) return null
      options.base = value
      index += 1
    } else return null
  }

  if (targets.length > 1) return null
  if (targets.length === 1) call.target = targets[0]
  if (Object.keys(options).length > 0) call.options = options
  const parsed = parsePlannotatorToolInput(call)
  return parsed.ok ? parsed.input : null
}
