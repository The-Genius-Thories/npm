'use strict'
const path = require('path')
const fs = require('graceful-fs')
const Bluebird = require('bluebird')
const rimraf = Bluebird.promisify(require('rimraf'))
const mkdirp = Bluebird.promisify(require('mkdirp'))
const lstat = Bluebird.promisify(fs.lstat)
const readdir = Bluebird.promisify(fs.readdir)
const symlink = Bluebird.promisify(fs.symlink)
const gentlyRm = require('../../utils/gently-rm')
const moduleStagingPath = require('../module-staging-path.js')
const readJson = Bluebird.promisify(require('read-package-json'))
const move = require('move-concurrently')
const updatePackageJson = Bluebird.promisify(require('../update-package-json'))
const moveOpts = {fs: fs, Promise: Bluebird, maxConcurrency: 4}

module.exports = function (staging, pkg, log, next) {
  log.silly('finalize', pkg.realpath)

  const extractedTo = moduleStagingPath(staging, pkg)

  const delpath = path.join(path.dirname(pkg.realpath), '.' + path.basename(pkg.realpath) + '.DELETE')
  let movedDestAway = false

  if (pkg.package._requested.type === 'directory') {
    return makeParentPath(pkg.path)
      .then(() => symlink(pkg.realpath, pkg.path, 'junction'))
      .then(refreshPackageJson)
  } else {
    return makeParentPath(pkg.realpath)
      .then(moveStagingToDestination, next)
      .then(restoreOldNodeModules)
      .catch((err) => {
        if (movedDestAway) {
          return rimraf(pkg.realpath).then(moveOldDestinationBack).thenReturn(Promise.reject(err))
        } else {
          return Promise.reject(err)
        }
      })
      .then(() => rimraf(delpath))
      .then(refreshPackageJson)
  }

  function makeParentPath (dir) {
    return mkdirp(path.dirname(dir))
  }

  function moveStagingToDestination () {
    return destinationIsClear()
      .then(actuallyMoveStaging)
      .catch(() => moveOldDestinationAway().then(actuallyMoveStaging))
  }

  function destinationIsClear () {
    return lstat(pkg.realpath).then(() => Bluebird.reject(false), () => Bluebird.resolve())
  }

  function actuallyMoveStaging () {
    return move(extractedTo, pkg.realpath, moveOpts)
  }

  function moveOldDestinationAway () {
    return rimraf(delpath).then(() => move(pkg.realpath, delpath, moveOpts)).then(() => { movedDestAway = true })
  }

  function moveOldDestinationBack () {
    return move(delpath, pkg.realpath, moveOpts).then(() => { movedDestAway = false })
  }

  function restoreOldNodeModules () {
    if (!movedDestAway) return
    return readdir(path.join(delpath, 'node_modules')).catch(() => []).then((modules) => {
      if (!modules.length) return
      return mkdirp(path.join(pkg.realpath, 'node_modules')).then(() => Bluebird.map(modules, (file) => {
        const from = path.join(delpath, 'node_modules', file)
        const to = path.join(pkg.realpath, 'node_modules', file)
        return move(from, to, moveOpts)
      }))
    })
  }
  function refreshPackageJson () {
    return readJson(path.join(pkg.path, 'package.json'), false).then((metadata) => {
      // Copy _ keys (internal to npm) and any missing keys from the possibly incomplete
      // registry metadata over to the full package metadata read off of disk.
      Object.keys(pkg.package).forEach(function (key) {
        if (key[0] === '_' || !(key in metadata)) metadata[key] = pkg.package[key]
      })
      metadata.name = pkg.package.name // things go wrong if these don't match
      // These two sneak in and it's awful
      delete metadata.readme
      delete metadata.readmeFilename
      pkg.package = metadata
    }).catch(() => 'ignore').then(() => {
      if (pkg.package._requested.type !== 'directory') {
        return updatePackageJson(pkg, pkg.path)
      }
    })
  }
}

module.exports.rollback = function (top, staging, pkg, next) {
  gentlyRm(pkg.realpath, false, top, next)
}
