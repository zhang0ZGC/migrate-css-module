/**
 * 迁移项目中引用的样式文件到CSS Module
 * 
 * 思路:
 * 1. 遍历项目中所有js|ts|jsx|tsx文件
 * 2. 解析文件内容, 找到import全局样式文件语句
 * 3. 读取样式文件内容, 同时修改页面中相关的className，改成styles对象引用方式，scss文件中一些特殊selector需要被保留，如taro ui的全局类：(/^.at-/)
 * 4. 保存脚本文件内容修改，并将全局样式文件重命名为*.module.{css|scss}（使用git mv命令以保持历史记录追踪）
 * 
 * 相关调试代码:
 * @link https://astexplorer.net/#/gist/9858aa6148d1638f634b84498cc8ec88/a1cb21c50429bb50e733d0ed3c7f382ee14d2cb3
 */

import { program } from 'commander'
import fs from 'fs/promises'
import path from 'path'
import { globby } from 'globby'
import jscodeshift from 'jscodeshift'
import postcss from 'postcss'
import postcssScss from 'postcss-scss'
import PostcssModulesPlugin from 'postcss-modules'
import * as sass from 'sass'
import chalk from 'chalk'
import ora from 'ora'
import { simpleGit } from 'simple-git'
import { exec } from 'child_process'
import nodeUtils from 'node:util'
import { detectNewlineCharacter, isGlobalStyle } from './utils/index.mjs'

program
  .description('Migrate project from global CSS to CSS modules')
  .version('0.1.0')
  .option('-d, --dry', 'dry run, only print the result, do not modify the files')
  .option('--ignore-pattern [pattern...]', 'ignore files matching the given pattern')
  .argument('<projectDir>', 'The Project Root Directory. Such as "./"')
  .action((projectDir, options) => {
    // console.log(projectDir, options)
  })
program.parse()

// console.log(program.opts())
if (!program.args[0]) {
  console.log(chalk.red('请指定要处理的文件夹'))
  process.exit(1)
}
const ROOT_PATH = path.resolve(program.args[0])

const DRY = program.opts().dry

const execAsync = nodeUtils.promisify(exec)

const j = jscodeshift.withParser('tsx');
const git = simpleGit({
  baseDir: ROOT_PATH,
})

async function migrateCssModule() {
  const files = await globby(
    ['src/**/*.{js,ts,jsx,tsx}',],
    {
      ignore: [
        '**/*.d.ts',
        'src/app.{js,ts,jsx,tsx}',
        '**/*.config.{js,ts,jsx,tsx}',
        '**/node_modules/**',
        'dist/**'
      ].concat(program.opts().ignorePattern || []),
      absolute: true,
      cwd: ROOT_PATH
    }
  )
  console.log(`find ${files.length} files`)

  const report = {
    succeed: [],
    ignored: []
  }


  // 需要进行处理的全局样式文件，
  // 在处理完js文件后处理，避免多个脚本引用同一个样式文件，重命名后其它脚本引用了改文件会找不到
  const collectedStyleFiles = new Set()
  /**
   * 错误信息收集
   * @type {Map<string, string[]>} key: 文件路径，value: 错误信息列表
   */
  const collectedWarnings = new Map()
  for (const file of files) {
    // const spinner = ora(`${file}\t`).start()
    // console.log(`process ${file}`)
    const content = await fs.readFile(file, 'utf-8')
    const lineTerminator = detectNewlineCharacter(content)

    const root = j(content)
    const globalStylesImporDecls = root.find(jscodeshift.ImportDeclaration, i => {
      return i.specifiers.length === 0 && isGlobalStyle(i.source.value)
    })
    if (globalStylesImporDecls.length === 0) {
      report.ignored.push(file)
      console.log(`${chalk.bgGray('SKIP')} ${file}`);
      continue
    }
    // console.log(`find ${globalStylesImporDecls.length} global style import declarations`)
    const STYLE_OBJ_PREFIX = 'styles'

    const importDeclarationPaths = globalStylesImporDecls.paths()

    // 检查当前文件是否导入classnames库，并获取导入的变量名
    let classNamesImportName
    const classNamesImport = root.find(j.ImportDeclaration, { source: { value: 'classnames' } })
    if (classNamesImport.size() === 0) {
      classNamesImportName = 'clsx'
      const classNamesImportDecl = j.importDeclaration([j.importDefaultSpecifier(j.identifier(classNamesImportName))], j.stringLiteral('classnames'))
      const imports = root.find(j.ImportDeclaration)
      imports.at(imports.size() - 1).insertAfter(classNamesImportDecl)
    } else {
      const classNamesImportNode = classNamesImport.paths()[0].node
      classNamesImportName = classNamesImportNode.specifiers[0].local.name
    }

    // 查找所有导入声明中使用stylObjPrefix的变量，并计算其数量
    // 以确保当前文件中不含有将使用的styles对象
    // 但是，如果styles对象是从props或state等变量导入的，则无法处理，可以借助eslint检查错误
    let _cur = root.find([j.ImportDefaultSpecifier, j.ImportSpecifier], { local: { name: STYLE_OBJ_PREFIX } }).size()

    for (const styleDeclPath of importDeclarationPaths) {
      const styleFileImportValue = styleDeclPath.node.source.value
      const styleFilePath = path.resolve(path.dirname(file), styleFileImportValue)

      collectedStyleFiles.add(styleFilePath)

      const styleObjName = STYLE_OBJ_PREFIX + (_cur === 0 ? '' : _cur.toString())
      _cur += 1;

      // 预处理样式文件中的特殊selector，如taro ui的全局类，
      // 这种selector需要在文件改为CSS Module后，保证不会被转换（几给selector套上一层:global()）
      if (!DRY) {
        await transformStyleFile(styleFilePath)
      }
      // 编译样式文件并收集className映射关系
      const result = await analyzeStyles(styleFilePath)
      const { classNameMap } = result

      // 将导入语句替换为css module导入语句
      j(styleDeclPath).replaceWith(j.importDeclaration(
        [j.importDefaultSpecifier(j.identifier(styleObjName))],
        j.stringLiteral(getTransformedGlobalStyleFileName(styleFileImportValue))
      ))
      //decl.node.source = j.stringLiteral(transformGlobalStyleFileName(decl.node.source.value))
      // 遍历JSX节点，处理className

      const classNameAttributePaths = root.find(j.JSXAttribute, { name: { name: 'className' } }).paths()

      /**
       * 处理className属性值
       * @param {import('jscodeshift').JSXExpressionContainer['expression']} value
       * @return {import('jscodeshift').CallExpression['arguments'] | null} 为null时，表示不处理
       */
      const transformClassNameAttributeNodeValue = (value) => {
        /** @type {import('jscodeshift').CallExpression['arguments']} */
        let collectArguments = []

        if (value.type === 'StringLiteral') {
          // const classList = value.value.split(/\s+/g).filter(i => i)
          // 经测试，空字符串不能过滤掉
          const classList = value.value.split(/\s+/g)
          if (classList.some(i => classNameMap[cssModuleLocalsConvention(i)])) {
            // const clsxExpression = j.callExpression(j.identifier(classNamesImportName), [])
            classList.forEach(className => {
              const localName = cssModuleLocalsConvention(className)
              if (classNameMap[localName]) {
                collectArguments.push(j.memberExpression(j.identifier(styleObjName), j.identifier(localName)))
              } else {
                collectArguments.push(j.stringLiteral(className))
              }
            })
            // node.value = j.jsxExpressionContainer(clsxExpression)
          } else {
            return null
          }
        } else if (value.type === 'TemplateLiteral') {
          // `icon-${iconName}` 这种形式需要保留，不能拆开。特征：对应的quasis中前或后没有空格
          // @TODO 这种形式的应该给出警告，很有可能拼接出来的class被转成了CSS Module
          // 递归处理表达式
          for (let i = 0; i < value.expressions.length; i++) {
            const leftQuasis = value.quasis[i]
            const rightQuasis = value.quasis[i + 1]

            const prcessQuasisClassList = classList => {
              classList.forEach(className => {
                const localName = cssModuleLocalsConvention(className)
                if (classNameMap[localName]) {
                  collectArguments.push(j.memberExpression(j.identifier(styleObjName), j.identifier(localName)))
                } else {
                  collectArguments.push(j.stringLiteral(className))
                }
              })
            }
            // 处理左侧字符串
            const leftClassList = leftQuasis.value.cooked.split(/\s+/g).filter(i => i)
            if (i !== 0 && !/^\s/.test(leftQuasis.value.cooked)) leftClassList.shift()
            if (!/\s$/.test(leftQuasis.value.cooked)) leftClassList.pop()
            prcessQuasisClassList(leftClassList)

            // 处理表达式
            const expression = value.expressions[i]
            const transRes = transformClassNameAttributeNodeValue(expression)
            if (!/\s$/.test(leftQuasis.value.cooked) || !/^\s/.test(rightQuasis.value.cooked)) {
              const leftStr = /\s$/.test(leftQuasis.value.cooked) ? '' : leftQuasis.value.cooked.split(/\s+/g).slice(-1)[0]
              const rightStr = /^\s/.test(rightQuasis.value.cooked) ? '' : rightQuasis.value.cooked.split(/\s+/g)[0]
              const newTemplateExpress = j.templateLiteral(
                [j.templateElement({ raw: leftStr, cooked: leftStr }, false), j.templateElement({ raw: rightStr, cooked: rightStr }, true)],
                [
                  transRes ? transRes.length === 1 ? transRes[0] : j.arrayExpression(transRes) : expression,
                ]
              )
              collectArguments.push(newTemplateExpress)
            } else {
              if (transRes) {
                collectArguments = collectArguments.concat(transRes)
              } else {
                collectArguments.push(expression)
              }
            }
            // 处理右侧字符串(只需要处理最后一个)
            if (rightQuasis.tail && rightQuasis.value.cooked.trim()) {
              const rightClassList = rightQuasis.value.cooked.split(/\s+/g).filter(i => i)
              if (!/^\s/.test(rightQuasis.value.cooked)) rightClassList.shift()
              prcessQuasisClassList(rightClassList)
            }
          }
        } else if (value.type === 'CallExpression') {
          if (value.callee.name !== classNamesImportName) {
            console.log(chalk.red(file))
            throw new Error(`className 值使用了不确定的函数 ${expression.callee.name}， 请先手动检查。line: ${expression.loc.start.line}`)
          }
          value.arguments.forEach(arg => {
            const transformRes = transformClassNameAttributeNodeValue(arg)
            if (transformRes) {
              collectArguments = collectArguments.concat(transformRes)
            } else {
              collectArguments.push(arg)
            }
          })
        } else if (value.type === 'ConditionalExpression') {
          const newExpression = j.conditionalExpression(value.test, j.nullLiteral(), j.nullLiteral())
          let leftTransformRes = transformClassNameAttributeNodeValue(value.consequent)
          if (leftTransformRes) {
            leftTransformRes = leftTransformRes.filter(i => i.type !== 'StringLiteral' || i.value.trim() !== '')
            newExpression.consequent = leftTransformRes.length === 1 ? leftTransformRes[0] : j.arrayExpression(leftTransformRes)
          } else {
            newExpression.consequent = value.consequent
          }

          let rightTransformRes = transformClassNameAttributeNodeValue(value.alternate)
          if (rightTransformRes) {
            rightTransformRes = rightTransformRes.filter(i => i.type !== 'StringLiteral' || i.value.trim() !== '')
            newExpression.alternate = rightTransformRes.length === 1 ? rightTransformRes[0] : j.arrayExpression(rightTransformRes)
          } else {
            newExpression.alternate = value.alternate
          }
          collectArguments.push(newExpression)
        } else if (value.type === 'BinaryExpression') {
          // className={'card ' + (level ? ' bg-white' : ' ') + ' color--red'}
          // => className={classNames('card', level? 'bg-white' : '', 'color--red')})
          if (value.operator !== '+') {
            throw new Error(`className 值使用了不支持的运算符 ${expression.operator}, 当前只支持+，请先手动处理。${file}:${expression.loc.start.line}`)
          }
          const leftTransRes = transformClassNameAttributeNodeValue(value.left)
          const rightTransRes = transformClassNameAttributeNodeValue(value.right)

          let newExpression = j.binaryExpression(value.operator, j.nullLiteral(), j.nullLiteral())

          if (leftTransRes) {
            if (leftTransRes.length > 1) {
              collectArguments = collectArguments.concat(leftTransRes.slice(0, leftTransRes.length - 1))
            }
            newExpression.left = leftTransRes[leftTransRes.length - 1]
          } else {
            newExpression.left = value.left
          }
          if (rightTransRes) {
            newExpression.right = rightTransRes[0]
            if (rightTransRes.length > 1) {
              collectArguments = collectArguments.concat(rightTransRes.slice(1))
            }
          } else {
            newExpression.right = value.right
          }

          // 假如left或right是空字符串，可以直接过滤掉
          // eg. '' + (condition ? 'a' : '') + '' => (condition ? 'a' : '')
          if ([newExpression.left, newExpression.right].some(i => i.type === 'StringLiteral' && i.value === '')) {
            if (newExpression.left.type === 'StringLiteral' && newExpression.left.value === '') {
              newExpression = newExpression.right
            } else {
              newExpression = newExpression.left
            }
          }

          collectArguments.push(newExpression)
        } else if (value.type === 'LogicalExpression') {
          if (value.right.type === 'StringLiteral') {
            let rightTransformRes = transformClassNameAttributeNodeValue(value.right)
            if (rightTransformRes) {
              if (rightTransformRes.length === 1) rightTransformRes = rightTransformRes[0]
              else rightTransformRes = j.arrayExpression(rightTransformRes)
              collectArguments.push(j.logicalExpression(value.operator, value.left, rightTransformRes))
            } else {
              collectArguments.push(value)
            }
          } else {
            collectArguments.push(value)
          }
        } else if (value.type === 'ArrayExpression') {
          const newArrayExpression = j.arrayExpression([])
          value.elements.forEach(element => {
            let transformRes = transformClassNameAttributeNodeValue(element)
            if (transformRes) {
              if (transformRes.length === 1) transformRes = transformRes[0]
              newArrayExpression.elements.push(transformRes)
            }
          })
          collectArguments.push(newArrayExpression)
        } else if (value.type === 'ObjectExpression') {
          const newObj = j.objectExpression([])
          value.properties.forEach(prop => {
            if (prop.key.type === 'Identifier' && classNameMap[cssModuleLocalsConvention(prop.key.name)]) {
              const localName = cssModuleLocalsConvention(prop.key.name)
              newObj.properties.push(j.objectProperty.from({
                key: j.memberExpression(j.identifier(styleObjName), j.identifier(localName)),
                value: prop.value,
                computed: true
              }))
            } else if (prop.key.type === 'StringLiteral') {
              // {x: true}
              const transRes = transformClassNameAttributeNodeValue(prop.key)
              if (transRes) {
                transRes.forEach(i => {
                  newObj.properties.push(j.objectProperty.from({
                    key: i,
                    value: prop.value,
                    computed: i.type === 'MemberExpression'
                  }))
                })
              } else {
                newObj.properties.push(prop)
              }
              // } else if (prop.key.type === 'MemberExpression') {
              //   // {[styles.x]: true}
              //   newObj.properties.push(prop)
              // }
            } else {
              newObj.properties.push(prop)
            }
          })
          collectArguments.push(newObj)
        } else if (['NullLiteral', 'NumericLiteral', 'BooleanLiteral', 'Identifier', 'MemberExpression'].includes(value.type)) {
          return null
        } else {
          return null
          // throw new Error(`unsupported className value type ${value.type}`)
          // console.log(chalk.yellow(`unsupported className value type ${valueType}`))
        }

        return collectArguments.length ? collectArguments : null
      }

      for (const path of classNameAttributePaths) {
        const node = path.node
        const valueType = node.value.type
        if (valueType === 'StringLiteral') {
          // 字符串形式
          // <div className="a b"></div>
          // <div className={'a b'}></div>
          const transformRes = transformClassNameAttributeNodeValue(node.value)
          if (transformRes) {
            if (transformRes.length === 1 && transformRes[0].type === 'MemberExpression') {
              node.value = j.jsxExpressionContainer(transformRes[0])
            } else {
              const clsxExpression = j.callExpression(j.identifier(classNamesImportName), transformRes)
              node.value = j.jsxExpressionContainer(clsxExpression)
            }
          } else {
            // 未找到映射关系，识别为全局样式，不处理
          }
          /* 
          const classList = node.value.value.split(/\s+/g)
          if (classList.some(i => result.classNameMap[cssModuleLocalsConvention(i)])) {
            const clsxExpression = j.callExpression(j.identifier(classNamesImportName), [])
            classList.forEach(className => {
              const localName = cssModuleLocalsConvention(className)
              if (result.classNameMap[localName]) {
                clsxExpression.arguments.push(j.memberExpression(j.identifier(styleObjName), j.identifier(localName)))
              } else {
                clsxExpression.arguments.push(j.stringLiteral(className))
              }
            })
            node.value = j.jsxExpressionContainer(clsxExpression)
          } else {
            // 未找到映射关系，识别为全局样式，不处理
          }
          */
        } else if (valueType === 'JSXExpressionContainer') {
          // 表达式形式，包含一下几种形式
          // <div className={`a ${'b'}`}></div>
          // <div className={classnames('a', 'b')}></div>
          // ...
          const expression = node.value.expression

          const transformRes = transformClassNameAttributeNodeValue(expression)
          if (transformRes && transformRes.length > 0) {
            if (transformRes.length === 1 && transformRes[0].type === 'MemberExpression') {
              node.value = j.jsxExpressionContainer(transformRes[0])
            } else {
              const clsxExpression = j.callExpression(j.identifier(classNamesImportName), transformRes)
              node.value = j.jsxExpressionContainer(clsxExpression)
            }
          } else {
            // 转换失败失败，不处理
          }
        } else {
          console.log(chalk.yellow(`unsupported className value type ${valueType}`))
        }
      }


      // console.log('Result:')
      // console.log('------------------------------------------')
      // console.log(root.toSource({ quote: 'single' }))
      // console.log('------------------------------------------')

      // await renameStyleFile(styleFilePath)
    }
    if (!DRY) {
      await fs.writeFile(file, root.toSource({ quote: 'single', lineTerminator }), 'utf-8')
    }
    // spinner.succeed(`${chalk.bgGreen(' OK ')} ${file}`);
    console.log(`${chalk.bgGreen(' OK ')} ${file}`);
    report.succeed.push(file)
  }
  console.log(chalk.bgGreen.white(`脚本文件处理完成\n`))

  console.log('💄开始处理样式文件重命名')

  const cssSpinner = ora('').start()
  // 处理样式文件
  if (!DRY) {
    for (const styleFile of collectedStyleFiles) {
      cssSpinner.text = styleFile
      await renameStyleFile(styleFile)
    }
  }
  cssSpinner.succeed(chalk.green('样式文件重命名处理完成'))
  console.log("\n")

  console.log(chalk.green('迁移完成'))
  console.log(`成功处理 ${report.succeed.length} 个页面/组件文件，忽略 ${report.ignored.length} 个文件`)
  console.log(`成功处理 ${collectedStyleFiles.size} 个样式文件`)
  console.log('请检查确认代码')
}

// 查找样式文件
async function findStyleFiles() {
  const files = await globby(
    ['**/*.{css,less,sass,scss,}', '!**/*.module.{css,less,sass,scss}'],
    {
      ignore: ["**/app.scss"]
    }
  )
  return files
}


/**
 * postcss插件，用于给全局class selector添加`:global()`，以便面后续被转换为CSS Module
 * @returns 
 */
const postcssTransformGloablSelectorPlugin = () => {
  return {
    postcssPlugin: 'postcss-transform-global-selector-plugin',
    Once(root, result) {
      root.walkRules(rule => {
        // 保留taro-ui的.at-xxx选择器
        if (/\.at-[\w_-]+/.test(rule.selector)) {
          root.source.input.globalSelectorTransformed = true
          rule.selector = rule.selector.replace(/(.at-[\w-_]+)(?:$|\b)/g, (match) => `:global(${match})`)
        }
      })
    }
  }
}
postcssTransformGloablSelectorPlugin.postcss = true

/**
 * 转换样式文件内容，给全局class selector添加`:global()`
 * @param {string} file 
 */
async function transformStyleFile(file) {
  const content = await fs.readFile(file, 'utf-8')
  const result = await postcss([
    postcssTransformGloablSelectorPlugin
  ]).process(content, {
    syntax: postcssScss,
    from: file,
  })
  if (result.root.source.input.globalSelectorTransformed) {
    await fs.writeFile(file, result.css, 'utf-8')
  }
  return {
    file: file,
    globalSelectorTransformed: result.root.source.input.globalSelectorTransformed,
    content: result.css,
  }
}

/**
 * 编译分析样式文件，获取编译结果及样式文件中所有className及其映射关系
 * @param {string} file 
 * @returns {{css: string, classNameMap: {[key: string]: string}}}
 */
async function analyzeStyles(file) {
  const scssResult = await sass.compileAsync(file, {
    // 自定义导入处理器
    importers: [
      {
        findFileUrl(url) {
          if (url.startsWith('~')) {
            return path.join(ROOT_PATH, 'node_modules', url.slice(1))
          }
          // 返回 null 使用默认解析器
          return null
        }
      }
    ],
    loadPaths: [
      ROOT_PATH,
      path.join(ROOT_PATH, 'node_modules')
    ],
    quietDeps: true,
    silenceDeprecations: ['import', 'global-builtin'],
  })
  const css = scssResult.css

  const moduleData = {
    css: '',
    classNameMap: {}
  }
  const processor = postcss([
    PostcssModulesPlugin({
      // 使用默认camelCaseOnly会将首字母大写转成小写，因此自定义转换
      localsConvention: cssModuleLocalsConvention,
      getJSON: (cssFileName, json) => {
        moduleData.classNameMap = json
      }
    })
  ])
  const result = await processor.process(css, {
    from: file,
  })

  moduleData.css = result.css

  // console.log(chalk.bgGreen.white('原始CSS内容:'))
  // console.log(css)
  // console.log(chalk.bgGreen.white('编译后CSS内容:'))
  // console.log(result.css)
  // console.log(chalk.bgGreen.white('样式文件中className映射关系:'))
  // console.log(moduleData.classNameMap)
  return moduleData
}

/**
 * 
 * @param {string} name 
 * @returns {string}
 */
function cssModuleLocalsConvention(name) {
  // 使用默认camelCaseOnly会将首字母大写转成小写，因此自定义转换
  return name.replace(/-+(\w)/g, (match, firstLetter) => firstLetter.toUpperCase())
}

function getTransformedGlobalStyleFileName(value) {
  return value.replace(/\.(css|less|sass|scss)$/, '.module.$1')
}

/**
 * 重命名样式文件为.module.{css|less|sass|scss}
 * @param {string} filePath 
 */
async function renameStyleFile(filePath) {
  const newFilePath = getTransformedGlobalStyleFileName(filePath)
  // await execAsync(`git mv ${filePath} ${newFilePath}`)
  const res = await git.mv(filePath, newFilePath)
  // console.log(res)
}

// 执行迁移
migrateCssModule()
