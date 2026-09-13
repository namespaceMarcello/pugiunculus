#!/usr/bin/env node
// Refuses a commit that touches the code and documents nothing. It does not block
// the user: it blocks Claude, which updates the file and commits again.
const { execFileSync } = require('node:child_process')

let dati = ''
process.stdin.on('data', (c) => (dati += c))
process.stdin.on('end', () => {
  let cmd = ''
  try {
    cmd = JSON.parse(dati || '{}').tool_input?.command || ''
  } catch {
    process.exit(0)
  }
  if (!/\bgit\b[\s\S]*\bcommit\b/.test(cmd)) process.exit(0)
  let staged = []
  try {
    staged = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)
  } catch {
    process.exit(0)
  }
  if (!staged.length) process.exit(0)
  const code = staged.some((f) => /^hooks\//.test(f) || /^(install|measure|measure-context|test)\.cjs$/.test(f))
  if (!code || staged.includes('docs/archivio/FATTO.md')) process.exit(0)
  console.error(
    'This commit touches the hooks and documents nothing.\n' +
      'Add 2-5 lines at the end of docs/archivio/FATTO.md:\n' +
      '  ### <date> — <title>\n  what was implemented, and how to try it.\n' +
      'Update docs/STATO.md ONLY if a decision, a defect or a next step changed\n' +
      '(replace the entry, never add one beside it). Then stage and commit again.\n' +
      'Files in this commit: ' +
      staged.join(', ')
  )
  process.exit(2)
})
