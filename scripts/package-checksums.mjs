import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const target = process.argv[2]
const extensions = { mac: /\.(dmg|zip)$/, linux: /\.(AppImage|deb|rpm)$/, win: /\.(exe|zip)$/ }
if (!Object.hasOwn(extensions, target)) throw new Error('Expected mac, linux or win')
const names = fs.readdirSync('dist').filter(name => extensions[target].test(name)).sort()
if (!names.length) throw new Error(`No ${target} artifacts found`)
const lines = []
for (const name of names) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(path.join('dist', name))) hash.update(chunk)
  lines.push(`${hash.digest('hex')}  ${name}`)
}
fs.writeFileSync(`dist/SHA256SUMS-${target}.txt`, lines.join('\n') + '\n')
