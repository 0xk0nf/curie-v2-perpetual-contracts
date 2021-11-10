import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber, BigNumberish, ContractReceipt, ContractTransaction } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { it } from "mocha"
import {
    AccountBalance,
    BaseToken,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import {
    addOrder,
    b2qExactInput,
    b2qExactOutput,
    closePosition,
    q2bExactInput,
    removeAllOrders,
} from "../helper/clearingHouseHelper"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { forward, forwardTimestamp } from "../shared/time"
import { encodePriceSqrt, filterLogs } from "../shared/utilities"
import { createClearingHouseFixture } from "./fixtures"

// https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=1341567235
describe("ClearingHouse accounting verification in xyk pool", () => {
    const [admin, maker, taker, maker2, taker2, maker3, taker3] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: TestExchange
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let vault: Vault
    let insuranceFund: InsuranceFund
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number
    let fixture

    let makerCollateral: BigNumber
    let takerCollateral: BigNumber

    beforeEach(async () => {
        const uniFeeRatio = 500 // 0.05%
        const exFeeRatio = 1000 // 0.1%

        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(true, uniFeeRatio))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        exchange = _clearingHouseFixture.exchange as TestExchange
        accountBalance = _clearingHouseFixture.accountBalance
        marketRegistry = _clearingHouseFixture.marketRegistry
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        insuranceFund = _clearingHouseFixture.insuranceFund
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()
        fixture = _clearingHouseFixture

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("10", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt("10", "1"))
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        // update config
        await marketRegistry.addPool(baseToken.address, uniFeeRatio)
        await marketRegistry.setFeeRatio(baseToken.address, exFeeRatio)
        await marketRegistry.setInsuranceFundFeeRatio(baseToken.address, 100000) // 10%

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // prepare collateral for maker
        makerCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateral)
        await deposit(maker, vault, 1000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("1000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerPosition: false,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for taker
        takerCollateral = parseUnits("100", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
        await deposit(taker, vault, 100, collateral)

        // expect all available and debt are zero
        const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(taker.address, baseToken.address)
        expect(baseBalance).be.deep.eq(parseEther("0"))
        expect(quoteBalance).be.deep.eq(parseEther("0"))

        // maker2
        // prepare collateral for maker2
        await collateral.mint(maker2.address, makerCollateral)
        await deposit(maker2, vault, 1000, collateral)

        // taker2
        // prepare collateral for taker2
        await collateral.mint(taker2.address, takerCollateral)
        await deposit(taker2, vault, 100, collateral)

        // maker3
        // prepare collateral for maker2
        await collateral.mint(maker3.address, makerCollateral)
        await deposit(maker3, vault, 1000, collateral)

        // taker3
        // prepare collateral for taker2
        await collateral.mint(taker3.address, takerCollateral)
        await deposit(taker3, vault, 100, collateral)
    })

    function getTakerFee(receipt: ContractReceipt): BigNumber {
        const logs = filterLogs(receipt, exchange.interface.getEventTopic("PositionChanged"), exchange)
        let fees = BigNumber.from(0)
        for (const log of logs) {
            fees = fees.add(log.args.fee)
        }
        return fees
    }

    function takerLongExactInput(amount): Promise<ContractTransaction> {
        return clearingHouse.connect(taker).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: true,
            oppositeAmountBound: 0,
            amount: parseEther(amount.toString()),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })
    }

    function takerShortExactInput(amount): Promise<ContractTransaction> {
        return clearingHouse.connect(taker).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: true,
            isExactInput: true,
            oppositeAmountBound: 0,
            amount: parseEther(amount.toString()),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })
    }

    function takerLongExactOutput(amount): Promise<ContractTransaction> {
        return clearingHouse.connect(taker).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: false,
            oppositeAmountBound: 0,
            amount: parseEther(amount.toString()),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })
    }

    function takerShortExactOutput(amount): Promise<ContractTransaction> {
        return clearingHouse.connect(taker).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: true,
            isExactInput: false,
            oppositeAmountBound: 0,
            amount: parseEther(amount.toString()),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })
    }

    function takerCloseEth(): Promise<ContractTransaction> {
        return clearingHouse.connect(taker).closePosition({
            baseToken: baseToken.address,
            sqrtPriceLimitX96: 0,
            oppositeAmountBound: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })
    }

    async function makerRemoveLiquidity(): Promise<ContractTransaction> {
        const order = await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick)
        const liquidity = order.liquidity
        return clearingHouse.connect(maker).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
    }

    async function getTakerMakerPositionSizeDelta(): Promise<BigNumberish> {
        const takerPosSize = await accountBalance.getTotalPositionSize(taker.address, baseToken.address)
        const makerPosSize = await accountBalance.getTotalPositionSize(maker.address, baseToken.address)
        return takerPosSize.add(makerPosSize)
    }

    it("taker's balance after = taker's balance before + realizedPnl", async () => {
        await takerLongExactInput(100)
        await takerCloseEth()
        const freeCollateral = await vault.getFreeCollateral(taker.address)

        await vault.connect(taker).withdraw(collateral.address, freeCollateral.toString())

        // 100 - 0.199900000000000024 ~= 99.800100
        expect(await collateral.balanceOf(taker.address)).eq(parseUnits("99.800100", 6))
    })

    it("won't emit funding payment settled event since the time is freeze", async () => {
        const openPositionTx = await takerLongExactInput(100)
        expect(openPositionTx).not.to.emit(exchange, "FundingPaymentSettled")
        const closePositionTx = await takerCloseEth()
        expect(closePositionTx).not.to.emit(exchange, "FundingPaymentSettled")
    })

    describe("zero sum game", () => {
        afterEach(async () => {
            // taker original 100 + maker original 1000 = taker after + maker after + insurance fund
            const takerFreeCollateral = await vault.getFreeCollateral(taker.address)
            const makerFreeCollateral = await vault.getFreeCollateral(maker.address)
            const insuranceFreeCollateral = await vault.getFreeCollateral(insuranceFund.address)
            expect(takerFreeCollateral.add(makerFreeCollateral).add(insuranceFreeCollateral)).to.be.closeTo(
                parseUnits("1100", 6),
                2,
            )
        })

        it("taker long exact input", async () => {
            await takerLongExactInput(100)
            expect(await getTakerMakerPositionSizeDelta()).be.closeTo(BigNumber.from(0), 2)

            await takerCloseEth()
            expect((await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).toString()).eq("0")

            await makerRemoveLiquidity()
        })

        it("taker short exact input", async () => {
            await takerShortExactInput(1)
            expect(await getTakerMakerPositionSizeDelta()).be.closeTo(BigNumber.from(0), 2)

            await takerCloseEth()
            expect((await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).toString()).eq("0")

            await makerRemoveLiquidity()
        })

        it("taker long exact output", async () => {
            await takerLongExactOutput(1)
            expect(await getTakerMakerPositionSizeDelta()).be.closeTo(BigNumber.from(0), 2)

            await takerCloseEth()
            expect((await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).toString()).eq("0")

            await makerRemoveLiquidity()
        })

        it("taker short exact output", async () => {
            await takerShortExactOutput(100)
            expect(await getTakerMakerPositionSizeDelta()).be.closeTo(BigNumber.from(0), 2)

            await takerCloseEth()
            expect((await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).toString()).eq("0")

            await makerRemoveLiquidity()
        })
    })

    it("has same realizedPnl once everyone close their position", async () => {
        const openPositionTx = await takerLongExactInput(100)
        expect(openPositionTx).to.emit(exchange, "PositionChanged").withArgs(
            taker.address, // trader
            baseToken.address, // baseToken
            "9082643876716065096", // exchangedPositionSize
            "-99900000000000000000", // exchangedPositionNotional
            "100000000000000001", // fee
            "-100000000000000000001", // openNotional
            "0", // realizedPnl
            "275570539067715219511427190085", // sqrtPriceAfter
        )

        const closePositionTx = await takerCloseEth()
        expect(closePositionTx).to.emit(exchange, "PositionChanged").withArgs(
            taker.address, // trader
            baseToken.address, // baseToken
            "-9082643876716065096", // exchangedPositionSize
            "99899999999999999978", // exchangedPositionNotional
            "99900000000000001", // fee
            "0", // openNotional
            "-199900000000000024", // realizedPnl
            "250541448375047931191432615077", // sqrtPriceAfter
        )

        // maker remove liquidity
        const order = await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick)
        const liquidity = order.liquidity
        const makerRemoveLiquidityTx = await clearingHouse.connect(maker).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
        expect(makerRemoveLiquidityTx).to.emit(orderBook, "LiquidityChanged").withArgs(
            maker.address,
            baseToken.address,
            quoteToken.address,
            lowerTick,
            upperTick,
            "-99999999999999999982", // return base
            "-1000000000000000000019", // return quote
            "-316227766016837933205", // liquidity
            "179909999999999999", // fee (100000000000000001 + 99900000000000001) * 90%
        )

        // ifOwedRealizedPnl + taker's realizedPnl from event + maker's quoteFee from event ~= 0
        const ifOwedRealizedPnl = (await accountBalance.getOwedAndUnrealizedPnl(insuranceFund.address))[0]
        expect(
            ifOwedRealizedPnl.add(BigNumber.from("179909999999999999")).sub(BigNumber.from("199900000000000024")),
        ).be.closeTo(BigNumber.from("0"), 25)
    })

    describe("complicated test", async () => {
        let totalCollateralWithdrawn: BigNumber

        beforeEach(() => {
            totalCollateralWithdrawn = BigNumber.from(0)
        })

        afterEach(async () => {
            const users = [maker, maker2, maker3, taker, taker2, taker3]

            let totalAccountValue = BigNumber.from(0)
            const totalCollateralDeposited = makerCollateral.mul(3).add(takerCollateral.mul(3))

            for (const user of users) {
                const accountValue = await clearingHouse.getAccountValue(user.address)
                totalAccountValue = totalAccountValue.add(accountValue)
            }

            const insuranceFreeCollateral = await vault.getFreeCollateral(insuranceFund.address)

            // rounding error in 6 decimals with 1wei
            expect(totalAccountValue.div(1e12).add(insuranceFreeCollateral)).to.be.closeTo(
                totalCollateralDeposited.sub(totalCollateralWithdrawn),
                1,
            )
        })

        it("single take", async () => {
            // taker open, taker fee 100 * 0.1% = 0.1
            await q2bExactInput(fixture, taker, 100)

            // maker move liquidity
            await removeAllOrders(fixture, maker)
            await addOrder(fixture, maker, 100, 1000, lowerTick + 6000, upperTick - 6000)

            // taker close
            await closePosition(fixture, taker)
            expect(await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).to.be.deep.eq(0)

            // maker account value = freeCollateral + unsettled PnL
            const makerAccountValue = await clearingHouse.getAccountValue(maker.address)
            const makerCollateral = await vault.getBalance(maker.address)
            const [makerOwedRealizedPnl, makerUnsettledPnL] = await accountBalance.getOwedAndUnrealizedPnl(
                maker.address,
            )
            expect(makerAccountValue).to.be.deep.eq(
                makerCollateral.mul(1e12).add(makerOwedRealizedPnl).add(makerUnsettledPnL),
            )

            // maker remove liquidity
            await removeAllOrders(fixture, maker)
        })

        it("multiple takes with rounding error", async () => {
            // taker, taker2, taker3 open
            await q2bExactInput(fixture, taker, 12.345678)
            await q2bExactInput(fixture, taker2, 26.54321)
            await b2qExactInput(fixture, taker3, 0.321)

            // maker move liquidity
            await removeAllOrders(fixture, maker)
            await addOrder(fixture, maker, 100, 1000, lowerTick + 2000, upperTick - 2000)

            // taker, taker2, taker3 close
            await closePosition(fixture, taker)
            await closePosition(fixture, taker2)
            await closePosition(fixture, taker3)

            expect(await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).to.be.deep.eq(0)

            // maker remove liquidity
            await removeAllOrders(fixture, maker)
        })

        it("multiple makers with multiple takers", async () => {
            // taker, taker2, taker3 open
            await q2bExactInput(fixture, taker, 50.456)
            await q2bExactInput(fixture, taker2, 0.123)
            await b2qExactInput(fixture, taker3, 0.987)

            // maker2, maker3 add liquidity
            await addOrder(fixture, maker2, 100, 1000, lowerTick, upperTick)
            await addOrder(fixture, maker3, 100, 1000, lowerTick, upperTick)

            // taker, taker2, taker3 close
            await closePosition(fixture, taker)
            await closePosition(fixture, taker2)
            await closePosition(fixture, taker3)

            const maker1PositionSize = await accountBalance.getTotalPositionSize(maker.address, baseToken.address)
            const maker2PositionSize = await accountBalance.getTotalPositionSize(maker2.address, baseToken.address)
            const maker3PositionSize = await accountBalance.getTotalPositionSize(maker3.address, baseToken.address)
            expect(maker1PositionSize.add(maker2PositionSize).add(maker3PositionSize)).to.be.closeTo("0", 10)

            // makers remove liquidity
            await removeAllOrders(fixture, maker)
            await removeAllOrders(fixture, maker2)
            await removeAllOrders(fixture, maker3)
        })

        it("discontinuous liquidity", async () => {
            // remove maker1 liquidity
            await removeAllOrders(fixture, maker)

            // maker1 and maker2 add liquidity
            // current tick = 23027
            await addOrder(fixture, maker, 2, 200, 23000, 24000)
            await addOrder(fixture, maker2, 2, 200, 25000, 27000)

            // end tick = 25689
            await q2bExactInput(fixture, taker, 30)

            // taker close position
            await closePosition(fixture, taker)

            const maker1PositionSize = await accountBalance.getTotalPositionSize(maker.address, baseToken.address)
            const maker2PositionSize = await accountBalance.getTotalPositionSize(maker2.address, baseToken.address)
            expect(maker1PositionSize.add(maker2PositionSize)).to.be.closeTo("0", 10)

            // maker remove liquidity
            await removeAllOrders(fixture, maker)
            await removeAllOrders(fixture, maker2)
        })

        it("taker takes profit", async () => {
            // taker open, taker fee 100 * 0.1% = 0.1
            await q2bExactInput(fixture, taker, 100)

            // maker move
            await removeAllOrders(fixture, maker)
            await addOrder(fixture, maker, 100, 1000, lowerTick + 2000, upperTick - 2000)

            // taker reduce position
            await b2qExactOutput(fixture, taker, 30)

            // taker withdraw
            const takerFreeCollateral = await vault.getFreeCollateral(taker.address)
            await vault.connect(taker).withdraw(collateral.address, takerFreeCollateral)
            totalCollateralWithdrawn = totalCollateralWithdrawn.add(takerFreeCollateral)

            // taker close
            await closePosition(fixture, taker)

            expect(await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).to.be.deep.eq(0)

            // maker remove liquidity
            await removeAllOrders(fixture, maker)
        })

        it("maker takes profit", async () => {
            // maker, maker2 add liquidity
            await addOrder(fixture, maker, 2, 200, lowerTick, upperTick)
            await addOrder(fixture, maker2, 2, 200, lowerTick, upperTick)

            // taker open
            await q2bExactInput(fixture, taker, 32.123)

            // maker2 remove liquidity & close position
            await removeAllOrders(fixture, maker2)
            await closePosition(fixture, maker2)

            // taker close
            await closePosition(fixture, taker)

            expect(await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).to.be.deep.eq(0)

            // maker remove liquidity
            await removeAllOrders(fixture, maker)
        })

        it("funding payment arbitrage", async () => {
            // taker open
            await q2bExactInput(fixture, taker, 20.1234)
            await forward(300)

            // index price change and funding rate reversed
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("15", 6), 0, 0, 0]
            })

            // taker open reverse
            await b2qExactOutput(fixture, taker, 30)
            await forward(300)

            // taker close
            await closePosition(fixture, taker)

            // remove liquidity
            await removeAllOrders(fixture, maker)
        })

        it("price-induced liquidation", async () => {
            // maker add liquidity
            await addOrder(fixture, maker, 100, 10000, lowerTick, upperTick)

            // taker open
            await q2bExactInput(fixture, taker, 150)

            // set index price to let taker underwater
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("0.1", 6), 0, 0, 0]
            })

            // liquidate taker
            while ((await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).gt(0)) {
                await clearingHouse.connect(taker2).liquidate(taker.address, baseToken.address)
            }

            expect(await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).to.be.deep.eq(0)

            // maker remove liquidity
            await removeAllOrders(fixture, maker)
        })

        it("funding-induced liquidation", async () => {
            // maker add liquidity
            await addOrder(fixture, maker, 100, 10000, lowerTick, upperTick)

            // taker open
            await q2bExactInput(fixture, taker, 150)

            // set index price to let taker pay funding fee
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("4", 6), 0, 0, 0]
            })

            // taker pays funding
            while ((await clearingHouse.getAccountValue(taker.address)).gt(0)) {
                await forwardTimestamp(clearingHouse, 3000)
                await exchange.settleFunding(taker.address, baseToken.address)
            }

            // liquidate taker
            while ((await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).gt(0)) {
                await clearingHouse.connect(taker2).liquidate(taker.address, baseToken.address)
            }
        })

        it("bad debt", async () => {
            // maker add liquidity
            await addOrder(fixture, maker, 100, 10000, lowerTick, upperTick)

            // taker open, quote input: 300, base output: 26.06426925
            await q2bExactInput(fixture, taker, 300)

            // maker move liquidity
            await removeAllOrders(fixture, maker)
            await addOrder(fixture, maker, 30, 10000, lowerTick, upperTick)

            // taker close, quote output: 184.21649272
            await closePosition(fixture, taker)

            // taker has bad debt
            expect(await clearingHouse.getAccountValue(taker.address)).to.be.lt(0)

            // maker remove liquidity
            await removeAllOrders(fixture, maker)
        })

        it("maker account value should reflect unsettled PnL", async () => {
            // maker add liquidity
            await addOrder(fixture, maker, 100, 10000, lowerTick, upperTick)

            // taker open
            await q2bExactInput(fixture, taker, 150)
        })
    })
})
