const { join } = require('node:path')
const { existsSync } = require('fs-extra')
const { merge } = require('webpack-merge')

const { log, warn, progress } = require('../../utils/logger.js')
const { AppBuilder } = require('../../app-builder.js')
const { quasarElectronConfig } = require('./electron-config.js')
const { getPackageJson } = require('../../utils/get-package-json.js')
const { getFixedDeps } = require('../../utils/get-fixed-deps.js')

module.exports.QuasarModeBuilder = class QuasarModeBuilder extends AppBuilder {
  async build () {
    await this.#buildFiles()
    await this.#writePackageJson()
    this.#copyElectronFiles()

    this.printSummary(join(this.quasarConf.build.distDir, 'UnPackaged'))

    if (this.argv[ 'skip-pkg' ] !== true) {
      await this.#packageFiles()
    }
  }

  async #buildFiles () {
    const webpackConf = await quasarElectronConfig.webpack(this.quasarConf)

    await this.buildWithWebpack('Electron UI', webpackConf)

    const mainConfig = await quasarElectronConfig.main(this.quasarConf)
    await this.buildWithEsbuild('Electron Main', mainConfig)

    const preloadList = await quasarElectronConfig.preloadScriptList(this.quasarConf)
    for (const preloadScript of preloadList) {
      await this.buildWithEsbuild(`Electron Preload (${ preloadScript.scriptName })`, preloadScript.esbuildConfig)
    }
  }

  async #writePackageJson () {
    const { appPkg } = this.ctx.pkg
    const pkg = merge({}, appPkg)

    if (pkg.dependencies) {
      pkg.dependencies = getFixedDeps(pkg.dependencies, this.ctx.appPaths.appDir)
      delete pkg.dependencies[ '@quasar/extras' ]
      delete pkg.dependencies[ 'register-service-worker' ]
    }

    // we don't need this (also, faster install time & smaller bundles)
    delete pkg.devDependencies
    delete pkg.browserslist
    delete pkg.scripts

    pkg.main = './electron-main.mjs'

    if (typeof this.quasarConf.electron.extendPackageJson === 'function') {
      this.quasarConf.electron.extendPackageJson(pkg)
    }

    this.writeFile(
      'UnPackaged/package.json',
      this.quasarConf.metaConf.debugging === true
        ? JSON.stringify(pkg, null, 2)
        : JSON.stringify(pkg)
    )
  }

  #copyElectronFiles () {
    const patterns = [
      '.yarnrc',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml'
      // bun.lockb should be ignored since it errors out with devDeps in package.json
      // (error: lockfile has changes, but lockfile is frozen)
    ].map(filename => ({
      from: filename,
      to: './UnPackaged'
    }))

    patterns.push({
      from: this.ctx.appPaths.resolve.electron('icons'),
      to: './UnPackaged/icons'
    })

    this.copyFiles(patterns)

    // handle .npmrc separately
    const npmrc = this.ctx.appPaths.resolve.app('.npmrc')
    let content = existsSync(npmrc)
      ? this.readFile(npmrc)
      : ''

    if (content.indexOf('shamefully-hoist') === -1) {
      content += '\n# needed by pnpm\nshamefully-hoist=true'
    }
    // very important, otherwise PNPM creates symlinks which is NOT
    // what we want for an Electron app that should run cross-platform
    if (content.indexOf('node-linker') === -1) {
      content += '\n# pnpm needs this otherwise it creates symlinks\nnode-linker=hoisted'
    }

    this.writeFile(
      join(this.quasarConf.build.distDir, 'UnPackaged/.npmrc'),
      content
    )
  }

  async #packageFiles () {
    const { appPaths, cacheProxy } = this.ctx

    const nodePackager = cacheProxy.getModule('nodePackager')
    nodePackager.install({
      cwd: join(this.quasarConf.build.distDir, 'UnPackaged'),
      params: this.quasarConf.electron.unPackagedInstallParams,
      displayName: 'UnPackaged folder production',
      env: 'production'
    })

    if (typeof this.quasarConf.electron.beforePackaging === 'function') {
      log('Running beforePackaging()')
      log()

      const result = this.quasarConf.electron.beforePackaging({
        appPaths,
        unpackagedDir: join(this.quasarConf.build.distDir, 'UnPackaged')
      })

      if (result && result.then) {
        await result
      }

      log()
      log('[SUCCESS] Done running beforePackaging()')
    }

    const bundlerName = this.quasarConf.electron.bundler
    const bundlerConfig = this.quasarConf.electron[ bundlerName ]

    const { getBundler } = cacheProxy.getModule('electron')
    const bundler = getBundler(bundlerName)
    const pkgBanner = `electron/${ bundlerName }`

    return new Promise((resolve, reject) => {
      const done = progress('Bundling app with ___...', pkgBanner)

      const bundlePromise = bundlerName === 'packager'
        ? bundler({
          ...bundlerConfig,
          electronVersion: getPackageJson('electron', appPaths.appDir).version
        })
        : bundler.build(bundlerConfig)

      bundlePromise
        .then(() => {
          log()
          done(`${ pkgBanner } built the app`)
          log()
          resolve()
        })
        .catch(err => {
          log()
          warn(`${ pkgBanner } could not build`, 'FAIL')
          log()
          console.error(err + '\n')
          reject()
        })
    })
  }
}
