import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  collectDesktopOutputFileHashes,
  verifyInternalReleaseAttestation,
} from './package-internal.mjs'

export function beforePackProjectDirectory(context) {
  const projectDirectory = context?.packager?.projectDir
  if (typeof projectDirectory !== 'string' || projectDirectory === '') {
    throw new Error('internal release attestation verification failed')
  }
  return projectDirectory
}

export default async function verifyInternalPack(context) {
  try {
    const projectDirectory = beforePackProjectDirectory(context)
    const packageMetadata = JSON.parse(readFileSync(
      resolve(projectDirectory, 'package.json'),
      'utf8',
    ))
    const attestation = JSON.parse(readFileSync(
      resolve(projectDirectory, 'out/internal-release-attestation.json'),
      'utf8',
    ))
    verifyInternalReleaseAttestation(attestation, {
      environment: process.env,
      version: packageMetadata.version,
      fileHashes: collectDesktopOutputFileHashes(resolve(projectDirectory, 'out')),
    })
  } catch {
    throw new Error('internal release attestation verification failed')
  }
}
