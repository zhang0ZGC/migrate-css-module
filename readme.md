# migrate-css-module

用于迁移项目中引用的全局样式文件到CSS Module，当前用于Taro项目


## 思路:
1. 遍历项目中所有js|ts|jsx|tsx文件
2. 解析文件内容, 找到import全局样式文件语句
3. 读取解析并修改样式文件内容, 同时修改页面中相关的className，改成styles对象引用方式，scss文件中一些特殊selector需要被保留，如taro ui的全局类：(`/.at-[\w-_]+/`)
4. 保存脚本文件内容修改，并将全局样式文件重命名为`*.module.{css|scss}`（使用`git mv`命令以保持历史记录追踪）


## Usage

下载项目代码，安装依赖

执行
```bash
node ./src/migrate-css-module.mjs <taro 项目路径>
```

例: `node ./src/migrate-css-module.mjs ../taro-project`

当前项目中test文件夹可共用于测试，可使用git查看修改结果 `node ./src/migrate-css-module.mjs ./test`

## 其它
查看帮助信息：
```bash
node ./src/migrate-css-module.mjs -h
```

理论上react项目都能处理，代码中只是加了一下taro场景的代码，主要是过滤了一些taro特有文件
