/* [学习注释]
 * 【本文件职责】通过显式种子和状态递推生成可复现的伪随机序列，并统计调用次数。
 * 相同初始seed、相同vMax序列、相同调用次数/顺序，才能期待相同输出；只统一seed还不够。
 * 这是共享静态状态，所有使用者都会推进同一序列。渲染/UI额外调用会影响后续玩法随机结果。
 * 用于玩法可复现性，不用于密码、令牌或安全随机。
 * [/学习注释]
 */
/**
 * @Author: YangWenJie
 * @Date: 2026-05-16 16:31:25
 * @LastEditors: YangWenJie
 * @LastEditTime: 2026-05-16 16:32:25
 * @Description: 随机数工具类
 */

export class MngRandomUtils {
    /* [学习注释]
     * 累计getRandom调用次数，resetRandomSeed归零；用来定位两端随机调用顺序分叉。
     * [/学习注释]
     */
    private static m_callNum = 0;
    /* [学习注释]
     * 初始种子，getRandomSeed返回它，不是当前已经递推到的m_currSeed。
     * [/学习注释]
     */
    private static m_seed = 0x8fff;
    /* [学习注释]
     * 递推状态取模边界0x7fffffff；数值计算仍使用JS number而非固定宽度整数溢出。
     * [/学习注释]
     */
    private static m_maxValue = 0x7fffffff;
    /* [学习注释]
     * 当前递推状态。0被当作未设置哨兵，取数时会改用初始seed。
     * [/学习注释]
     */
    private static m_currSeed = 0;

    /* [学习注释]
     * 先计数，再选择当前状态，调用递推并保存下一seed。对正常正整数vMax和非负适用状态，输出约定1..vMax。
     * 当前没有检查vMax<=0、非整数或异常seed；不能把任意输入都当有效随机区间。
     * [/学习注释]
     */
    public static getRandom(vMax: number): number {
        this.m_callNum = this.m_callNum + 1
        let tempSeed = 0
        if (this.m_currSeed == 0) {
            tempSeed = this.m_seed
        }
        else {
            tempSeed = this.m_currSeed
        }

        let tempRandom: number[] = this.getRandomValue(tempSeed, vMax);
        let tempRandNum = tempRandom[0];
        this.m_currSeed = tempRandom[1];
        /* [学习注释]
         * 余数通常为0..vMax-1，加1转换为从1开始；用作数组下标时需匹配这个约定。
         * [/学习注释]
         */
        return (tempRandNum + 1);
    }

    /* [学习注释]
     * 返回初始seed。要恢复对局中途随机状态，仅存这个值通常还需同时恢复调用进度。
     * [/学习注释]
     */
    public static getRandomSeed(): number {
        return this.m_seed;
    }

    /* [学习注释]
     * 同时改初始seed、当前seed并清次数。进房/回放使用统一入口建立相同序列起点。
     * [/学习注释]
     */
    public static resetRandomSeed(seed: number) {
        this.m_seed = seed;
        this.m_currSeed = seed;
        this.m_callNum = 0;
    }

    /* [学习注释]
     * 查询已经取数次数，不会再推进随机状态。
     * [/学习注释]
     */
    public static getRandomCallNum(): number {
        return this.m_callNum;
    }

    /* [学习注释]
     * 先算seed*1664525+12345，再对a取输出余数，随后对m_maxValue取下一状态。
     * 返回[余数, 下一seed]，返回数组本身不是两个独立随机数；与服务端对齐必须连运算顺序一起保持。
     * [/学习注释]
     */
    private static getRandomValue(seed: number, a: number): number[] {
        var tempSeed: number = seed;
        var tempA: number = a;
        let tempB: number;

        tempSeed = (tempSeed * 1664525) + 12345;
        tempB = tempSeed % tempA;
        tempSeed = tempSeed % this.m_maxValue;
        return [tempB, tempSeed];
    }
}