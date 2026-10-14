/* [学习注释]
 * 【本文件职责】把number向零截断到约四位小数，作为统一精度辅助。
 * 返回值仍是JavaScript浮点number，不是独立的定点数类型，不能仅靠它保证跨端完整物理确定性。
 * 例：1.23459→1.2345，-1.23459→-1.2345；不是四舍五入，也不是负数直接floor后的-1.2346。
 * [/学习注释]
 */
/* [学习注释]
 * 缓存Math.floor函数引用；没有修改全局Math。
 * [/学习注释]
 */
const mathFloor = Math.floor

/* [学习注释]
 * 缩放因子10000对应小数点后4位；先放大再截断再缩小。
 * [/学习注释]
 */
export const FixFloatLen = 10000;

export class MngFixFloat {
    // 获取固定浮点数
    /* [学习注释]
     * 正数直接floor；负数先取相反数floor，再恢复负号，达到向零截断。
     * 由于底层二进制浮点，乘10000仍可能有表示误差；输入NaN/Infinity也没有额外校验。
     * [/学习注释]
     */
    static getFixFloat(fnum: number): number {
        let tempFixNum = fnum * FixFloatLen;
        /* [学习注释]
         * 分正负处理的原因：Math.floor(-1.2)=-2，而向零截断应是-1。
         * [/学习注释]
         */
        if (tempFixNum >= 0) {
            tempFixNum = mathFloor(tempFixNum);
            tempFixNum = tempFixNum / FixFloatLen;
        } else {
            tempFixNum = mathFloor(-tempFixNum);
            tempFixNum = tempFixNum / FixFloatLen;
            tempFixNum = -tempFixNum;
        }
    
        return tempFixNum;
    }
}
