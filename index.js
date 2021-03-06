#!/usr/bin/env node
'use strict'

const BB = require('bluebird')

const child = require('./child')
const dotenv = require('dotenv')
const getPrefix = require('./get-prefix.js')
const parseArgs = require('./parse-args.js')
const path = require('path')
const pkg = require('./package.json')
let rimraf
const updateNotifier = require('update-notifier')
const which = BB.promisify(require('which'))
const Y = require('./y.js')

const PATH_SEP = process.platform === 'win32' ? ';' : ':'

updateNotifier({pkg}).notify()
main(parseArgs())

module.exports = main
function main (argv) {
  const shell = argv['shell-auto-fallback']
  if (shell || shell === '') {
    const fallback = require('./auto-fallback.js')(
      shell, process.env.SHELL, argv
    )
    if (fallback) {
      return console.log(fallback)
    } else {
      process.exitCode = 1
      return
    }
  }

  if (!argv.command || !argv.package) {
    console.error(Y`\nERROR: You must supply a command.\n`)
    parseArgs.showHelp()
    process.exitCode = 1
    return
  }

  return localBinPath(process.cwd()).then(local => {
    process.env.PATH = `${local}${PATH_SEP}${process.env.PATH}`
    return BB.join(
      getCmdPath(argv.command, argv.package, argv),
      getEnv(argv),
      (cmdPath, env) => {
        const currPath = process.env.PATH
        process.env = env
        process.env.PATH = currPath
        return child.runCommand(cmdPath, argv.cmdOpts, argv)
      }
    ).catch(err => {
      console.error(err.message)
      process.exitCode = err.exitCode || 1
    })
  })
}

module.exports._localBinPath = localBinPath
function localBinPath (cwd) {
  return getPrefix(cwd).then(prefix => {
    return path.join(prefix, 'node_modules', '.bin')
  })
}

module.exports._getEnv = getEnv
function getEnv (opts) {
  if (opts.call) {
    return child.exec(opts.npm, ['run', 'env']).then(env => {
      return dotenv.parse(env)
    })
  } else {
    return process.env
  }
}

module.exports._getCmdPath = getCmdPath
function getCmdPath (command, specs, npmOpts) {
  return getExistingPath(command, npmOpts).then(cmdPath => {
    if (cmdPath) {
      return cmdPath
    } else {
      return (
        npmOpts.cache ? BB.resolve(npmOpts.cache) : getNpmCache(npmOpts)
      ).then(cache => {
        const prefix = path.join(cache, '_npx')
        const bins = process.platform === 'win32'
        ? prefix
        : path.join(prefix, 'bin')
        if (!rimraf) { rimraf = BB.promisify(require('rimraf')) }
        return rimraf(bins).then(() => {
          return installPackages(specs, prefix, npmOpts).then(() => {
            process.env.PATH = `${bins}${PATH_SEP}${process.env.PATH}`
            return which(command)
          })
        })
      })
    }
  })
}

module.exports._getExistingPath = getExistingPath
function getExistingPath (command, opts) {
  if (opts.cmdHadVersion || opts.packageRequested || opts.ignoreExisting) {
    return BB.resolve(false)
  } else {
    return which(command).catch({code: 'ENOENT'}, err => {
      if (!opts.install) {
        err.exitCode = 127
        throw err
      }
    })
  }
}

module.exports._getNpmCache = getNpmCache
function getNpmCache (opts) {
  return which(opts.npm).then(npmPath => {
    const args = ['config', 'get', 'cache']
    if (opts.userconfig) {
      args.push('--userconfig', opts.userconfig)
    }
    return child.exec(npmPath, args)
  }).then(cache => cache.trim())
}

module.exports._buildArgs = buildArgs
function buildArgs (specs, prefix, opts) {
  const args = ['install'].concat(specs)
  args.push('--global', '--prefix', prefix)
  if (opts.cache) args.push('--cache', opts.cache)
  if (opts.userconfig) args.push('--userconfig', opts.userconfig)
  args.push('--loglevel', 'error', '--json')

  return args
}

module.exports._installPackages = installPackages
function installPackages (specs, prefix, npmOpts) {
  const args = buildArgs(specs, prefix, npmOpts)
  return which(npmOpts.npm).then(npmPath => {
    return child.spawn(npmPath, args, {
      stdio: [0, 'ignore', 2]
    }).catch(err => {
      if (err.exitCode) {
        err.message = Y`Install for ${specs} failed with code ${err.exitCode}`
      }
      throw err
    })
  })
}
