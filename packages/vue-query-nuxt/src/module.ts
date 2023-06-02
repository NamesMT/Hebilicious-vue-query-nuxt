import { existsSync, promises as fsp } from "node:fs"
import { addImports, addPlugin, addTemplate, createResolver, defineNuxtModule, useLogger } from "@nuxt/kit"
import { defu } from "defu"
import { generateCode, loadFile } from "magicast"
import { transform } from "esbuild"
import { NAME, type VueQueryOptions, configKey, defaults } from "./runtime/utils"

export default defineNuxtModule<VueQueryOptions>({
  meta: {
    name: NAME,
    configKey,
    compatibility: {
      nuxt: "^3"
    }
  },
  defaults,
  async setup(userOptions, nuxt) {
    const logger = useLogger(NAME)
    const { resolve } = createResolver(import.meta.url)

    logger.info(`Adding ${NAME} module...`)

    const { ...options } = userOptions
    // 1. Set up runtime configuration
    nuxt.options.runtimeConfig.public[configKey] = defu(nuxt.options.runtimeConfig.public[configKey], options, {})

    // 2. Add plugin
    addPlugin(resolve("./runtime/plugin"))

    // 3. Add composable
    addImports([{ name: "defineVueQueryPluginCallback", from: resolve("./runtime/composables/defineVueQueryPluginCallback") }])

    const filename = "internal.vue-query-plugin-callback.mjs"

    // 4. Write pluginCallback() to .nuxt
    const writeFile = async () => {
      let getContents = async () => "export function pluginCallback() {}"
      if (existsSync(resolve(nuxt.options.rootDir, "vue-query.config.ts"))) {
        const configFile = resolve(nuxt.options.rootDir, "vue-query.config.ts")
        const file = await loadFile(configFile)
        if (file.exports.pluginCallback || file.exports.default) {
          logger.success("Found vue-query.config.ts file")
          if (!file.exports.pluginCallback) file.exports.pluginCallback = file.exports.default
          delete file.exports.default
          const { code } = generateCode(file) // We extract it with magicast...
          const shaked = await transform(code, { treeShaking: true, loader: "ts" }) // ...we clean it with esbuild.
          getContents = async () => `${shaked.code}`
        }
        else {
          logger.error("Found vue-query.config.ts file, but it does not export a `pluginCallback`.")
        }
      }
      else {
        logger.info("No vue-query.config.ts file found.")
      }

      // @todo Make @nuxt/kit support this
      // addTemplate({ filename, write: true, getContents, replace: true })

      // Create file in .nuxt
      const filePath = resolve(nuxt.options.buildDir, filename)
      if (existsSync(filePath)) await fsp.rm(filePath)
      await fsp.writeFile(filePath, await getContents())
    }
    writeFile()

    // 4. Add types for the plugin callback.
    const advancedTypes = "types/vue-query-nuxt-advanced.d.ts"
    addTemplate({
      filename: advancedTypes,
      getContents: () => `
      type PluginCallbackResult = Awaited<ReturnType<typeof import(".nuxt/${filename}").pluginCallback>>
      
      type AddPrefix<T> = {
        [K in keyof T['provide'] as \`$\${string & K}\`]: T['provide'][K]
      }
      
      declare module '#app' {
        interface NuxtApp extends AddPrefix<PluginCallbackResult> {}
      }
      export { }`
    })
    nuxt.hook("prepare:types", ({ references }) => {
      references.push({ path: advancedTypes })
    })

    // 5. Auto - reload the config
    nuxt.hook("builder:watch", async (event, path) => {
      if (path.includes("vue-query.config.ts")) {
        logger.info(`[vue-query] config changed '@${event}'`, path)
        writeFile()
        logger.success("[vue-query] config reloaded.")
      }
    })

    logger.success(`Added ${NAME} module successfully.`)
  }
})
