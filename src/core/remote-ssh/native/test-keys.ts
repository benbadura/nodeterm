// Test helper: an Ed25519 key pair that ssh2 can read back.
//
// ssh2 1.17's `utils.generateKeyPairSync('ed25519')` strips every leading zero byte from the
// public key's DER BIT STRING, so a public key that itself starts with 0x00 (1 in 256) comes out
// 31 bytes long and the private key fails to parse ("Malformed OpenSSH private key"). MEASURED on
// this repo's ssh2: 67 of 20,000 generated keys. The native-SSH suites generate ~20 keys per run,
// which made roughly one CI run in 15 fail at random. Nothing outside tests generates keys this
// way. Same workaround as https://github.com/arjitc/ElectroSSH/pull/15: generate, parse back,
// retry.

import { utils } from 'ssh2'

type Ed25519Options = Parameters<typeof utils.generateKeyPairSync<'ed25519'>>[1]

export function ed25519KeyPair(opts?: Ed25519Options): utils.KeyPairReturn {
  const passphrase = opts && 'passphrase' in opts ? opts.passphrase : undefined
  for (let attempt = 0; attempt < 10; attempt++) {
    const pair = utils.generateKeyPairSync('ed25519', opts)
    if (!(utils.parseKey(pair.private, passphrase) instanceof Error) && !(utils.parseKey(pair.public) instanceof Error)) {
      return pair
    }
  }
  throw new Error('ssh2 produced 10 unreadable Ed25519 keys in a row')
}
