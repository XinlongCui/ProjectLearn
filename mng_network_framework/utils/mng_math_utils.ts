/* [学习注释]
 * 【本文件职责】精度辅助、二维向量计算和角度查表，部分历史平方根实验保留为注释。
 * 当前有效实现仍使用number和Math.sqrt，不是完整整数物理库。不同函数是否截断精度并不完全一致。
 * 底部MngMathUtils.init在模块加载时执行，建立1..180整数度的sin/cos表。
 * BigInt平方根函数及相关常量均已注释，不属于当前可调用API；历史性能数字也不是本次验证结果。
 * [/学习注释]
 */
import { FixFloatLen, MngFixFloat } from "./mng_fix_float";

/** fSqrt 内部缓存的 BigInt 常量，避免重复构造 */
// const FIX_SQRT_BIG_ZERO = 0n;
// const FIX_SQRT_BIG_ONE = 1n;
// const FIX_SQRT_BIG_TWO = 2n;
// const FIX_SQRT_BIG_FIX_LEN = BigInt(1000);
// const FIX_SQRT_BIT_HIGH = 1n << 62n;
// const FIX_SQRT_BIT_LOW = 1n << 30n;
// const FIX_SQRT_HIGH_MASK = 0xFFFFFFFF00000000n;

/**
 * 数学工具类
 */
export class MngMathUtils {
    /** 整数度 1~180：sin(deg) 保留 4 位小数后 ×10000 */
    /* [学习注释]
     * 索引对应整数角度1..180，值为round(sin角度×10000)，第0项并没有正常填充。
     * [/学习注释]
     */
    private static sinByDegree: number[] = new Array(181);
    /** 整数度 1~180：cos(deg) 保留 4 位小数后 ×10000 */
    /* [学习注释]
     * 与sin表配套；表内保存放大后的整数，使用时按接口约定决定是否除10000。
     * [/学习注释]
     */
    private static cosByDegree: number[] = new Array(181);

    /* [学习注释]
     * 遍历1..180，把角度转弧度后求三角函数并量化；不是从服务器读取固定常量表。
     * [/学习注释]
     */
    static init(): void {
        for (let deg = 1; deg <= 180; deg++) {
            const rad = (deg * Math.PI) / 180;
            MngMathUtils.sinByDegree[deg] = Math.round(Math.sin(rad) * 10000);
            MngMathUtils.cosByDegree[deg] = Math.round(Math.cos(rad) * 10000);
        }
    }

    /** 整数度 1~180 的 sin 定点值（×10000） */
    /* [学习注释]
     * 输入floor后夹到1..180，因此0度会按1度取值，不会自动处理完整360度周期；返回值仍放大10000倍。
     * [/学习注释]
     */
    static getSinFixedByDegree(degree: number): number {
        const deg = Math.max(1, Math.min(180, Math.floor(degree)));
        return MngMathUtils.sinByDegree[deg] ?? 0;
    }

    /** 整数度 1~180 的 cos 定点值（×10000） */
    /* [学习注释]
     * 同样限制在1..180并返回缩放整数；越界角度被夹紧而非周期归一化。
     * [/学习注释]
     */
    static getCosFixedByDegree(degree: number): number {
        const deg = Math.max(1, Math.min(180, Math.floor(degree)));
        return MngMathUtils.cosByDegree[deg] ?? 0;
    }

    /**
     * 安全除法
     * @param numerator 分子
     * @param denominator 分母
     * @param fallbackValue 默认值
     * @param warn 是否警告
     * @returns 结果
     */
    /* [学习注释]
     * 只检查typeof number及分母非零；NaN/Infinity也属于number，不会被完整拦截。非法分支可选日志并返回fallback。
     * [/学习注释]
     */
    static safeDivider(numerator: number, denominator: number, fallbackValue: number = 0.0, warn: boolean = false): number {
        if (typeof numerator === 'number' && typeof denominator === 'number' && denominator !== 0) {
            return numerator / denominator;
        }
        if (warn) {
            console.warn("非法除法运算");
        }
        return fallbackValue;
    }

    /**
     * 计算两个点的中点
     * @param ax x坐标
     * @param ay y坐标
     * @param bx x坐标
     * @param by y坐标
     * @returns 中点
     */
    /* [学习注释]
     * 两坐标分别取平均后用MngFixFloat向零截断4位；返回[x,y]元组。
     * [/学习注释]
     */
    static getMidPoint(ax: number, ay: number, bx: number, by: number): [number, number] {
        return [MngFixFloat.getFixFloat((ax + bx) * 0.5), MngFixFloat.getFixFloat((ay + by) * 0.5)];
    }

    /**
     * 计算2d坐标的距离平方
     * @param ax x坐标
     * @param ay y坐标
     * @param bx x坐标
     * @param by y坐标
     * @returns 距离平方
     */
    /* [学习注释]
     * 计算dx²+dy²，不开方，适合只比较距离大小的场景。该函数没有做结果四位截断。
     * 前置旧判空组合并非逐参数严格校验，返回99999只是特定条件下的哨兵，不能当作完善数值验证。
     * [/学习注释]
     */
    static get2DLenSquare(ax: number, ay: number, bx: number, by: number): number {
        // 增加保护之机制 , todo:外部调用逻辑最好保证此方法参数正确
        if ((!ax || !ay || !bx || !by) && ax != 0 && ay != 0 && bx != 0 && by != 0) {
            return 99999;
        }

        const dx = ax - bx;
        const dy = ay - by;
        const lenSq = dx * dx + dy * dy;
        return lenSq;
    }

    /**
     * 计算2d向量距离平方
     * @param vx x坐标
     * @param vy y坐标
     * @returns 距离平方
     */
    /* [学习注释]
     * 向量长度平方vx²+vy²，并对结果做四位截断；与上面的两点距离平方精度处理不同。
     * [/学习注释]
     */
    static get2DLenSquareByVect(vx: number, vy: number): number {
        const lenSq = vx * vx + vy * vy;
        return MngFixFloat.getFixFloat(lenSq);
    }

    /**
     * 计算2d向量距离
     * @param vx x坐标
     * @param vy y坐标
     * @returns 距离
     */
    /* [学习注释]
     * 先取已经截断的长度平方，再sqrt，最后再截断；量化顺序会影响最终结果。
     * [/学习注释]
     */
    static get2DLenByVect(vx: number, vy: number): number {
        const lenSq = MngMathUtils.get2DLenSquareByVect(vx, vy);
        return MngFixFloat.getFixFloat(Math.sqrt(lenSq));
    }

    /**
     * 计算2d坐标的距离平方
     * @param ax x坐标
     * @param ay y坐标
     * @returns 距离平方
     */
    /* [学习注释]
     * 实际返回归一化后的二维方向，不是旧注释写的距离平方。小长度时把除数改1，零向量仍为零。
     * 结果分量截断到4位，因此输出长度不一定严格等于1。
     * [/学习注释]
     */
    static normalizeVec2(ax: number, ay: number): [number, number] {
        let len = Math.sqrt(ax * ax + ay * ay);
        if (len < 1e-6) {
            len = 1;
        }
        return [MngFixFloat.getFixFloat(ax / len), MngFixFloat.getFixFloat(ay / len)];
    }

    /**
     * 限制一个值在最小值和最大值之间
     * @param v 值
     * @param min 最小值
     * @param max 最大值
     * @returns 限制后的值
     */
    /* [学习注释]
     * 边界反了就先交换，再夹到[min,max]；NaN比较均false会落入返回原值分支。
     * [/学习注释]
     */
    static clamp(v: number, min: number, max: number): number {
        if (min > max) {
            [min, max] = [max, min];
        }
        if (v > max) {
            return max;
        } else if (v < min) {
            return min;
        } else {
            return v;
        }
    }

    /**
     * 根据index获取对应的弧度值，用于客户端解析数据
     * @param index 索引
     * @returns 弧度值
     */
    /* [学习注释]
     * 名称虽含Rad，返回的是[sin,cos]方向分量，并非弧度角。index<=0返回[0,1]。
     * 正index按round(index*360/255)换成角度后夹到1..180；高半圈会被夹成180，不能假设完整256方向映射。
     * [/学习注释]
     */
    static getRadValueByIndex(index: number): number[] {
        if (index <= 0) {
            return [0, 1];
        }
        const deg = Math.min(180, Math.max(1, Math.round((index * 360) / 255)));
        return [
            MngMathUtils.getSinFixedByDegree(deg) / 10000,
            MngMathUtils.getCosFixedByDegree(deg) / 10000,
        ];
    }

    /**
     * 计算二维向量的点积
     * @param vect1x 向量1的x坐标
     * @param vect1y 向量1的y坐标
     * @param vect2x 向量2的x坐标
     * @param vect2y 向量2的y坐标
     * @returns 点积
     */
    /* [学习注释]
     * 点积x1*x2+y1*y2，常用于投影与判断夹角；此处不做精度截断或归一化。
     * [/学习注释]
     */
    static dot(vect1x: number, vect1y: number, vect2x: number, vect2y: number): number {
        return vect1x * vect2x + vect1y * vect2y;
    }

    /**
     * 计算二维向量的叉积（数量积，结果为标量，正负表示方向）
     * @param vect1x 向量1的x坐标
     * @param vect1y 向量1的y坐标
     * @param vect2x 向量2的x坐标
     * @param vect2y 向量2的y坐标
     * @returns 叉积
     */
    /* [学习注释]
     * 二维叉积的标量z分量x1*y2-y1*x2，正负反映旋转方向；不是点积。
     * [/学习注释]
     */
    static cross(vect1x: number, vect1y: number, vect2x: number, vect2y: number): number {
        return vect1x * vect2y - vect1y * vect2x;
    }

    /**
     * 帧同步定点数平方根 —— 基于 C++ fix32_sqrt 二进制逐位算法
     *
     * 【输入/输出均为定点数整数值（实际值 × FixFloatLen），直接对标 C++ 的 fix32_sqrt】
     * 例：FixFloatLen=10000，求 sqrt(2.0) 时传入 20000，返回 14142（表示 1.4142）
     *
     * 与 C++ fix32_sqrt 行为完全对齐：
     * ┌──────────────────────┬────────────────────────────────────────────┐
     * │ C++ fix32_sqrt       │ TS fix32Sqrt                              │
     * ├──────────────────────┼────────────────────────────────────────────┤
     * │ inValue (fix32_t)    │ scaledValue (定点整数, ×FixFloatLen)      │
     * │ fix32_one (65536)    │ FixFloatLen (10000)                       │
     * │ fix32_sqrt_one (256) │ sqrt(FixFloatLen) → 已隐式合并到初始缩放  │
     * │ sqrt(-x) = -sqrt(x)  │ 同 C++，负值返回负平方根                  │
     * │ INT64_MIN 溢出保护   │ BigInt 无溢出，不做检测                   │
     * └──────────────────────┴────────────────────────────────────────────┘
     *
     * ──────────────────────────────────────────────────────────────────────
     * ========== fSqrt 正确性验证 ==========
     * 样本数         : 100000
     * 最大绝对误差   : 2162.26840442  (输入=9999914.2661)
     * 最大相对误差   : 68.377585 %
     * 容差(1.00e-4)超出 : 99999 / 100000
     * 边界用例失败   : 7
     * 确定性失败     : 0
     * ========== fSqrt vs Math.sqrt 性能对比 ==========
     * 样本量: 100000  预热: 3 轮  正式: 5 轮  总调用: 500000
     * +------------+-----------+-----------+--------------------+
     * | 函数       | 总耗时ms  | 单次ns    | 吞吐(万次/秒)      |
     * +------------+-----------+-----------+--------------------+
     * | Math.sqrt  |      0.60 |       1.2 |           83333.33 |
     * | fSqrt      |    354.20 |     708.4 |             141.16 |
     * +------------+-----------+-----------+--------------------+
     * fSqrt 相对 Math.sqrt 慢 590.33 倍
     * ──────────────────────────────────────────────────────────────────────
     * 
     * @param scaledValue 定点数整数值（实际值 × FixFloatLen）
     * @returns 平方根的定点数整数值（实际值 × FixFloatLen），负输入返回负值
     */
    /* [学习注释]
     * 以下为已停用的历史实验代码。注释中的跨语言对齐/性能结论不代表当前运行路径。
     * 保留它供阅读算法思路，不在学习副本中取消注释启用。
     * [/学习注释]
     */
    // static fix32Sqrt(scaledValue: number): number {
    //     const neg = scaledValue < 0;
    //     const absVal = neg ? -scaledValue : scaledValue;
    //     if (absVal <= 0) return 0;

    //     let num = BigInt(absVal) * FIX_SQRT_BIG_FIX_LEN;
    //     let result = FIX_SQRT_BIG_ZERO;
    //     let bit = (num & FIX_SQRT_HIGH_MASK) ? FIX_SQRT_BIT_HIGH : FIX_SQRT_BIT_LOW;
    //     while (bit > num) {
    //         bit >>= FIX_SQRT_BIG_TWO;
    //     }

    //     while (bit > FIX_SQRT_BIG_ZERO) {
    //         const sum = result + bit;
    //         if (num >= sum) {
    //             num -= sum;
    //             result = (result >> FIX_SQRT_BIG_ONE) + bit;
    //         } else {
    //             result >>= FIX_SQRT_BIG_ONE;
    //         }
    //         bit >>= FIX_SQRT_BIG_TWO;
    //     }

    //     if (num > result) {
    //         result += FIX_SQRT_BIG_ONE;
    //     }

    //     return neg ? -Number(result) : Number(result);
    // }

    // /**
    //  * 帧同步定点数平方根（便捷版，接收/返回常规浮点数）
    //  *
    //  * 内部委托给 fix32Sqrt 完成核心计算。
    //  *
    //  * @param value 被开方数（< 0 视为 0；若需负数开方行为同 C++ 请使用 fix32Sqrt）
    //  * @returns 平方根（4 位小数定点精度）
    //  */
    /* [学习注释]
     * 已停用的浮点入口包装，试图转定点整数再调用实验sqrt；当前无法从运行时调用此方法。
     * [/学习注释]
     */
    // static fSqrt(value: number): number {
    //     if (!(value > 0)) { return 0; }

    //     const intInput = Math.floor(value * FixFloatLen);
    //     if (intInput <= 0) { return 0; }

    //     return MngMathUtils.fix32Sqrt(intInput) / FixFloatLen;
    // }
}

/* [学习注释]
 * 模块加载副作用：建立查表数据。导入本模块就会执行，不需要玩法另调一次才能有表。
 * [/学习注释]
 */
MngMathUtils.init();