import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { ethers, waffle } from "hardhat"
import { VirtualToken } from "../../typechain"
import { toWei } from "../helper/number"
import { virtualTokenFixture } from "./fixtures"

// TODO: should also test ChainlinkPriceFeed
describe("VirtualToken", async () => {
    const [admin] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let virtualToken: VirtualToken
    let mockedAggregator: MockContract
    let currentTime: number
    let roundData: any[]

    describe("twap", () => {
        beforeEach(async () => {
            const _fixture = await loadFixture(virtualTokenFixture)
            virtualToken = _fixture.virtualToken
            mockedAggregator = _fixture.mockedAggregator

            // `base` = now - _interval
            // aggregator's answer
            // timestamp(base + 0)  : 400
            // timestamp(base + 15) : 405
            // timestamp(base + 30) : 410
            // now = base + 45
            //
            //  --+------+-----+-----+-----+-----+-----+
            //          base                          now
            const latestTimestamp = (await waffle.provider.getBlock("latest")).timestamp
            currentTime = latestTimestamp
            roundData = [
                // [roundId, answer, startedAt, updatedAt, answeredInRound]
            ]

            currentTime += 0
            roundData.push([0, toWei(400, 6), currentTime, currentTime, 0])

            currentTime += 15
            roundData.push([1, toWei(405, 6), currentTime, currentTime, 1])

            currentTime += 15
            roundData.push([2, toWei(410, 6), currentTime, currentTime, 2])

            mockedAggregator.smocked.latestRoundData.will.return.with(async () => {
                return roundData[roundData.length - 1]
            })

            mockedAggregator.smocked.getRoundData.will.return.with((round: BigNumber) => {
                return roundData[round.toNumber()]
            })

            currentTime += 15
            await ethers.provider.send("evm_setNextBlockTimestamp", [currentTime])
            await ethers.provider.send("evm_mine", [])
        })

        it("twap price", async () => {
            const price = await virtualToken.getIndexPrice(45)
            expect(price).to.eq(toWei(405))
        })

        it("asking interval more than aggregator has", async () => {
            const price = await virtualToken.getIndexPrice(46)
            expect(price).to.eq(toWei(405))
        })

        it("asking interval less than aggregator has", async () => {
            const price = await virtualToken.getIndexPrice(44)
            expect(price).to.eq("405113636000000000000")
        })

        it("given variant price period", async () => {
            roundData.push([4, toWei(420, 6), currentTime + 30, currentTime + 30, 4])
            await ethers.provider.send("evm_setNextBlockTimestamp", [currentTime + 50])
            await ethers.provider.send("evm_mine", [])

            // twap price should be ((400 * 15) + (405 * 15) + (410 * 45) + (420 * 20)) / 95 = 409.736
            const price = await virtualToken.getIndexPrice(95)
            expect(price).to.eq("409736842000000000000")
        })

        it("latest price update time is earlier than the request, return the latest price", async () => {
            await ethers.provider.send("evm_setNextBlockTimestamp", [currentTime + 100])
            await ethers.provider.send("evm_mine", [])

            // latest update time is base + 30, but now is base + 145 and asking for (now - 45)
            // should return the latest price directly
            const price = await virtualToken.getIndexPrice(45)
            expect(price).to.eq(toWei(410))
        })

        it("if current price < 0, ignore the current price", async () => {
            roundData.push([3, toWei(-10, 6), 250, 250, 3])
            const price = await virtualToken.getIndexPrice(45)
            expect(price).to.eq(toWei(405))
        })

        it("if there is a negative price in the middle, ignore that price", async () => {
            roundData.push([3, toWei(-100, 6), currentTime + 20, currentTime + 20, 3])
            roundData.push([4, toWei(420, 6), currentTime + 30, currentTime + 30, 4])
            await ethers.provider.send("evm_setNextBlockTimestamp", [currentTime + 50])
            await ethers.provider.send("evm_mine", [])

            // twap price should be ((400 * 15) + (405 * 15) + (410 * 45) + (420 * 20)) / 95 = 409.736
            const price = await virtualToken.getIndexPrice(95)
            expect(price).to.eq("409736842000000000000")
        })

        it("return latest price if interval is zero", async () => {
            const price = await virtualToken.getIndexPrice(0)
            expect(price).to.eq(toWei(410))
        })
    })
})
