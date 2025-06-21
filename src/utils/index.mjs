/**
 * 根据字符串内容判断换行符
 * @param {string} str 
 * @returns 
 */
export function detectNewlineCharacter(str) {
  if (str.includes('\r\n')) {
    return '\r\n';
  } else if (str.includes('\n')) {
    return '\n';
  } else if (str.includes('\r')) {
    return '\n';
  } else {
    return "\n";
  }
}

const globalStyleRegex = /(?<!\.module)\.(css|scss|sass|less|styl)/

/**
 * 判断文件名是否是全局样式文件
 * @param {string} fileName 
 * @returns 
 */
export function isGlobalStyle(fileName) {
  return globalStyleRegex.test(fileName)
}