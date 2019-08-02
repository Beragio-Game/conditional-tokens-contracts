const ethSigUtil = require("eth-sig-util");

const { expectEvent, expectRevert } = require("openzeppelin-test-helpers");
const { toBN, soliditySha3, randomHex } = web3.utils;

const ConditionalTokens = artifacts.require("ConditionalTokens");
const ERC20Mintable = artifacts.require("MockCoin");
const ERC1155Mock = artifacts.require("ERC1155Mock");
const Forwarder = artifacts.require("Forwarder");
const DefaultCallbackHandler = artifacts.require("DefaultCallbackHandler.sol");
const GnosisSafe = artifacts.require("GnosisSafe");

const NULL_BYTES32 = `0x${"0".repeat(64)}`;

function getConditionId(
  oracle,
  questionId,
  payoutDenominator,
  outcomeSlotCount
) {
  return soliditySha3(
    { t: "address", v: oracle },
    { t: "bytes32", v: questionId },
    { t: "uint", v: payoutDenominator },
    { t: "uint", v: outcomeSlotCount }
  );
}

function getCollectionId(conditionId, indexSet) {
  return soliditySha3(
    { t: "bytes32", v: conditionId },
    { t: "uint", v: indexSet }
  );
}

// function combineCollectionIds(collectionIds) {
//   return (
//     "0x" +
//     collectionIds
//       .reduce((acc, collectionId) => acc.add(toBN(collectionId)), toBN(0))
//       .maskn(256)
//       .toString(16, 64)
//   );
// }

function getPositionId(collateralToken, collateralTokenID, collectionId) {
  if (collectionId == null)
    return soliditySha3(
      { t: "address", v: collateralToken },
      { t: "uint", v: collateralTokenID }
    );
  return soliditySha3(
    { t: "address", v: collateralToken },
    { t: "uint", v: collateralTokenID },
    { t: "uint", v: collectionId }
  );
}

const randint = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

contract("ConditionalTokens", function(accounts) {
  const [
    minter,
    oracle,
    notOracle,
    eoaTrader,
    fwdExecutor,
    safeExecutor,
    counterparty
  ] = accounts;

  beforeEach("deploy ConditionalTokens", async function() {
    this.conditionalTokens = await ConditionalTokens.new();
  });

  describe("prepareCondition", function() {
    it("should not be able to prepare a condition with no outcome slots", async function() {
      const questionId = randomHex(32);
      const payoutDenominator = randint(1, 1000);
      const outcomeSlotCount = 0;

      await expectRevert(
        this.conditionalTokens.prepareCondition(
          oracle,
          questionId,
          payoutDenominator,
          outcomeSlotCount
        ),
        "there should be more than one outcome slot"
      );
    });

    it("should not be able to prepare a condition with just one outcome slots", async function() {
      const questionId = randomHex(32);
      const payoutDenominator = randint(1, 1000);
      const outcomeSlotCount = 1;

      await expectRevert(
        this.conditionalTokens.prepareCondition(
          oracle,
          questionId,
          payoutDenominator,
          outcomeSlotCount
        ),
        "there should be more than one outcome slot"
      );
    });

    it("should not be able to prepare a condition with zero payout denominator", async function() {
      const questionId = randomHex(32);
      const payoutDenominator = 0;
      const outcomeSlotCount = 10;

      await expectRevert(
        this.conditionalTokens.prepareCondition(
          oracle,
          questionId,
          payoutDenominator,
          outcomeSlotCount
        ),
        "payout denominator invalid"
      );
    });

    context("with valid parameters", function() {
      const questionId = randomHex(32);
      const payoutDenominator = toBN(randint(1, 1000));
      const outcomeSlotCount = toBN(256);

      const conditionId = getConditionId(
        oracle,
        questionId,
        payoutDenominator,
        outcomeSlotCount
      );

      beforeEach(async function() {
        ({ logs: this.logs } = await this.conditionalTokens.prepareCondition(
          oracle,
          questionId,
          payoutDenominator,
          outcomeSlotCount
        ));
      });

      it("should emit an ConditionPreparation event", async function() {
        expectEvent.inLogs(this.logs, "ConditionPreparation", {
          conditionId,
          oracle,
          questionId,
          payoutDenominator,
          outcomeSlotCount
        });
      });

      it("should make outcome slot count available via getOutcomeSlotCount", async function() {
        (await this.conditionalTokens.getOutcomeSlotCount(
          conditionId
        )).should.be.bignumber.equal(outcomeSlotCount);
      });

      it("should make payout denominator available via payoutDenominator", async function() {
        (await this.conditionalTokens.payoutDenominator(
          conditionId
        )).should.be.bignumber.equal(payoutDenominator);
      });

      it("should not be able to prepare the same condition more than once", async function() {
        await expectRevert(
          this.conditionalTokens.prepareCondition(
            oracle,
            questionId,
            payoutDenominator,
            outcomeSlotCount
          ),
          "condition already prepared"
        );
      });
    });
  });

  describe("splitting and merging", function() {
    function shouldSplitAndMergePositions(trader) {
      const questionId = randomHex(32);
      const payoutDenominator = toBN(10);
      const outcomeSlotCount = toBN(2);

      const conditionId = getConditionId(
        oracle,
        questionId,
        payoutDenominator,
        outcomeSlotCount
      );

      const collateralTokenCount = toBN(1e19);
      const splitAmount = toBN(4e18);
      const mergeAmount = toBN(3e18);

      function shouldWorkWithSplittingAndMerging({
        prepareTokens,
        doSplit,
        doMerge,
        doRedeem,
        collateralBalanceOf,
        getPositionForCollection,
        getExpectedEventCollateralProperties
      }) {
        beforeEach(prepareTokens);

        it("should not split on unprepared conditions", async function() {
          await doSplit.call(
            this,
            conditionId,
            [0b01, 0b10],
            splitAmount
          ).should.be.rejected;
        });

        context("with a condition prepared", async function() {
          beforeEach(async function() {
            await this.conditionalTokens.prepareCondition(
              oracle,
              questionId,
              payoutDenominator,
              outcomeSlotCount
            );
          });

          it("should not split if given index sets aren't disjoint", async function() {
            await doSplit.call(
              this,
              conditionId,
              [0b11, 0b10],
              splitAmount
            ).should.be.rejected;
          });

          it("should not split if partitioning more than condition's outcome slots", async function() {
            await doSplit.call(
              this,
              conditionId,
              [0b001, 0b010, 0b100],
              splitAmount
            ).should.be.rejected;
          });

          it("should not split if given a singleton partition", async function() {
            await doSplit.call(
              this,
              conditionId,
              [0b11],
              splitAmount
            ).should.be.rejected;
          });

          it.skip("should not split if given an incomplete singleton partition", async function() {
            await doSplit.call(
              this,
              conditionId,
              [0b01],
              splitAmount
            ).should.be.rejected;
          });

          context("with valid split", function() {
            const partition = [0b01, 0b10];

            beforeEach(async function() {
              ({ tx: this.splitTx } = await doSplit.call(
                this,
                conditionId,
                partition,
                splitAmount
              ));
            });

            it.skip("should emit a PositionSplit event", async function() {
              await expectEvent.inTransaction(
                this.splitTx,
                ConditionalTokens,
                "PositionSplit",
                Object.assign(
                  {
                    stakeholder: trader.address,
                    parentCollectionId: NULL_BYTES32,
                    conditionId,
                    // partition,
                    amount: splitAmount
                  },
                  getExpectedEventCollateralProperties.call(this)
                )
              );
            });

            it("should transfer split collateral from trader", async function() {
              (await collateralBalanceOf.call(
                this,
                trader.address
              )).should.be.bignumber.equal(
                collateralTokenCount.sub(splitAmount)
              );
              (await collateralBalanceOf.call(
                this,
                this.conditionalTokens.address
              )).should.be.bignumber.equal(splitAmount);
            });

            it("should mint amounts in positions associated with partition", async function() {
              for (const indexSet of partition) {
                const positionId = getPositionForCollection.call(
                  this,
                  getCollectionId(conditionId, indexSet)
                );

                (await this.conditionalTokens.balanceOf(
                  trader.address,
                  positionId
                )).should.be.bignumber.equal(splitAmount);
              }
            });

            it("should not merge if amount exceeds balances in to-be-merged positions", async function() {
              await doMerge.call(
                this,
                conditionId,
                partition,
                splitAmount.addn(1)
              ).should.be.rejected;
            });

            context("with valid merge", function() {
              beforeEach(async function() {
                ({ tx: this.mergeTx } = await doMerge.call(
                  this,
                  conditionId,
                  partition,
                  mergeAmount
                ));
              });

              it("should emit a PositionsMerge event", async function() {
                await expectEvent.inTransaction(
                  this.mergeTx,
                  ConditionalTokens,
                  "PositionsMerge",
                  Object.assign(
                    {
                      stakeholder: trader.address,
                      parentCollectionId: NULL_BYTES32,
                      conditionId,
                      // partition,
                      amount: mergeAmount
                    },
                    getExpectedEventCollateralProperties.call(this)
                  )
                );
              });

              it("should transfer split collateral back to trader", async function() {
                (await collateralBalanceOf.call(
                  this,
                  trader.address
                )).should.be.bignumber.equal(
                  collateralTokenCount.sub(splitAmount).add(mergeAmount)
                );
                (await collateralBalanceOf.call(
                  this,
                  this.conditionalTokens.address
                )).should.be.bignumber.equal(splitAmount.sub(mergeAmount));
              });

              it("should burn amounts in positions associated with partition", async function() {
                for (const indexSet of partition) {
                  const positionId = getPositionForCollection.call(
                    this,
                    getCollectionId(conditionId, indexSet)
                  );

                  (await this.conditionalTokens.balanceOf(
                    trader.address,
                    positionId
                  )).should.be.bignumber.equal(splitAmount.sub(mergeAmount));
                }
              });
            });

            describe("transferring, reporting, and redeeming", function() {
              const transferAmount = toBN(1e18);
              const payoutNumerators = [toBN(3), toBN(7)];

              it("should not allow transferring more than split balance", async function() {
                const positionId = getPositionForCollection.call(
                  this,
                  getCollectionId(conditionId, partition[0])
                );

                await trader.execCall(
                  this.conditionalTokens,
                  "safeTransferFrom",
                  trader.address,
                  counterparty,
                  positionId,
                  splitAmount.addn(1),
                  "0x"
                ).should.be.rejected;
              });

              it("should not allow reporting by incorrect oracle", async function() {
                await expectRevert(
                  this.conditionalTokens.reportPayouts(
                    questionId,
                    payoutDenominator,
                    payoutNumerators,
                    { from: notOracle }
                  ),
                  "condition not prepared or found"
                );
              });

              it("should not allow report with wrong questionId", async function() {
                const wrongQuestionId = randomHex(32);
                await expectRevert(
                  this.conditionalTokens.reportPayouts(
                    wrongQuestionId,
                    payoutDenominator,
                    payoutNumerators,
                    { from: oracle }
                  ),
                  "condition not prepared or found"
                );
              });

              it("should not allow report with wrong payoutDenominator", async function() {
                const wrongPayoutDenominator = 1;
                await expectRevert(
                  this.conditionalTokens.reportPayouts(
                    questionId,
                    wrongPayoutDenominator,
                    payoutNumerators,
                    { from: oracle }
                  ),
                  "condition not prepared or found"
                );
              });

              it("should not allow report with no slots", async function() {
                await expectRevert(
                  this.conditionalTokens.reportPayouts(
                    questionId,
                    payoutDenominator,
                    [],
                    { from: oracle }
                  ),
                  "there should be more than one outcome slot"
                );
              });

              it("should not allow report with wrong number of slots", async function() {
                await expectRevert(
                  this.conditionalTokens.reportPayouts(
                    questionId,
                    payoutDenominator,
                    [2, 3, 5],
                    { from: oracle }
                  ),
                  "condition not prepared or found"
                );
              });

              it("should not allow report with zero payouts in all slots", async function() {
                await expectRevert(
                  this.conditionalTokens.reportPayouts(
                    questionId,
                    payoutDenominator,
                    [0, 0],
                    { from: oracle }
                  ),
                  "payout is all zeroes"
                );
              });

              it("should not allow report with payouts exceeding denominator", async function() {
                await expectRevert(
                  this.conditionalTokens.reportPayouts(
                    questionId,
                    payoutDenominator,
                    [3, 8],
                    { from: oracle }
                  ),
                  "payouts can't exceed denominator"
                );
              });

              context("with valid transfer and oracle report", function() {
                beforeEach(async function() {
                  const positionId = getPositionForCollection.call(
                    this,
                    getCollectionId(conditionId, partition[0])
                  );

                  ({ tx: this.transferTx } = await trader.execCall(
                    this.conditionalTokens,
                    "safeTransferFrom",
                    trader.address,
                    counterparty,
                    positionId,
                    transferAmount,
                    "0x"
                  ));
                  ({
                    logs: this.reportLogs
                  } = await this.conditionalTokens.reportPayouts(
                    questionId,
                    payoutDenominator,
                    payoutNumerators,
                    { from: oracle }
                  ));
                });

                it("should not merge if any amount is short", async function() {
                  await doMerge.call(
                    this,
                    conditionId,
                    partition,
                    splitAmount
                  ).should.be.rejected;
                });

                it("should emit ConditionResolution event", async function() {
                  expectEvent.inLogs(this.reportLogs, "ConditionResolution", {
                    conditionId,
                    oracle,
                    questionId,
                    outcomeSlotCount
                  });
                });

                it("should make reported payout numerators available", async function() {
                  for (let i = 0; i < payoutNumerators.length; i++) {
                    (await this.conditionalTokens.payoutNumerators(
                      conditionId,
                      i
                    )).should.be.bignumber.equal(payoutNumerators[i]);
                  }
                });

                describe("redeeming", function() {
                  const payout = [
                    splitAmount.sub(transferAmount),
                    splitAmount
                  ].reduce(
                    (acc, amount, i) =>
                      acc.add(
                        amount.mul(payoutNumerators[i]).div(payoutDenominator)
                      ),
                    toBN(0)
                  );

                  beforeEach(async function() {
                    ({ tx: this.redeemTx } = await doRedeem.call(
                      this,
                      conditionId,
                      partition
                    ));
                  });

                  it("should emit PayoutRedemption event", async function() {
                    await expectEvent.inTransaction(
                      this.redeemTx,
                      ConditionalTokens,
                      "PayoutRedemption",
                      Object.assign(
                        {
                          redeemer: trader.address,
                          parentCollectionId: NULL_BYTES32,
                          conditionId,
                          // indexSets: partition,
                          payout
                        },
                        getExpectedEventCollateralProperties.call(this)
                      )
                    );
                  });

                  it("should zero out redeemed positions", async function() {
                    for (const indexSet of partition) {
                      const positionId = getPositionForCollection.call(
                        this,
                        getCollectionId(conditionId, indexSet)
                      );
                      (await this.conditionalTokens.balanceOf(
                        trader.address,
                        positionId
                      )).should.be.bignumber.equal("0");
                    }
                  });

                  it("should not affect other's positions", async function() {
                    const positionId = getPositionForCollection.call(
                      this,
                      getCollectionId(conditionId, partition[0])
                    );
                    (await this.conditionalTokens.balanceOf(
                      counterparty,
                      positionId
                    )).should.be.bignumber.equal(transferAmount);
                  });

                  it("should credit payout as collateral", async function() {
                    (await collateralBalanceOf.call(
                      this,
                      trader.address
                    )).should.be.bignumber.equal(
                      collateralTokenCount.sub(splitAmount).add(payout)
                    );
                  });
                });
              });
            });
          });
        });
      }

      context("with an ERC-20 collateral allowance", function() {
        shouldWorkWithSplittingAndMerging({
          async prepareTokens() {
            this.collateralToken = await ERC20Mintable.new({ from: minter });
            await this.collateralToken.mint(
              trader.address,
              collateralTokenCount,
              { from: minter }
            );
            await trader.execCall(
              this.collateralToken,
              "approve",
              this.conditionalTokens.address,
              collateralTokenCount
            );
          },
          async doSplit(conditionId, partition, amount) {
            return await trader.execCall(
              this.conditionalTokens,
              "splitPosition",
              this.collateralToken.address,
              NULL_BYTES32,
              conditionId,
              partition,
              amount
            );
          },
          async doMerge(conditionId, partition, amount) {
            return await trader.execCall(
              this.conditionalTokens,
              "mergePositions",
              this.collateralToken.address,
              NULL_BYTES32,
              conditionId,
              partition,
              amount
            );
          },
          async doRedeem(conditionId, indexSets) {
            return await trader.execCall(
              this.conditionalTokens,
              "redeemPositions",
              this.collateralToken.address,
              NULL_BYTES32,
              conditionId,
              indexSets
            );
          },
          async collateralBalanceOf(address) {
            return await this.collateralToken.balanceOf(address);
          },
          getPositionForCollection(collectionId) {
            return getPositionId(this.collateralToken.address, collectionId);
          },
          getExpectedEventCollateralProperties() {
            return { collateralToken: this.collateralToken.address };
          }
        });
      });

      context("with ConditionalTokens as ERC-1155 operator", function() {
        const collateralTokenID = toBN(randomHex(32));

        shouldWorkWithSplittingAndMerging({
          async prepareTokens() {
            this.collateralMultiToken = await ERC1155Mock.new({
              from: minter
            });
            await this.collateralMultiToken.mint(
              trader.address,
              collateralTokenID,
              collateralTokenCount,
              "0x",
              { from: minter }
            );
            await trader.execCall(
              this.collateralMultiToken,
              "setApprovalForAll",
              this.conditionalTokens.address,
              true
            );
          },
          async doSplit(conditionId, partition, amount) {
            return await trader.execCall(
              this.conditionalTokens,
              "split1155Position",
              this.collateralMultiToken.address,
              collateralTokenID,
              NULL_BYTES32,
              conditionId,
              partition,
              amount
            );
          },
          async doMerge(conditionId, partition, amount) {
            return await trader.execCall(
              this.conditionalTokens,
              "merge1155Positions",
              this.collateralMultiToken.address,
              collateralTokenID,
              NULL_BYTES32,
              conditionId,
              partition,
              amount
            );
          },
          async doRedeem(conditionId, indexSets) {
            return await trader.execCall(
              this.conditionalTokens,
              "redeem1155Positions",
              this.collateralMultiToken.address,
              collateralTokenID,
              NULL_BYTES32,
              conditionId,
              indexSets
            );
          },
          async collateralBalanceOf(address) {
            return await this.collateralMultiToken.balanceOf(
              address,
              collateralTokenID
            );
          },
          getPositionForCollection(collectionId) {
            return getPositionId(
              this.collateralMultiToken.address,
              collateralTokenID,
              collectionId
            );
          },
          getExpectedEventCollateralProperties() {
            return {
              collateralToken: this.collateralMultiToken.address,
              collateralTokenID
            };
          }
        });
      });

      context("with direct ERC-1155 transfers", function() {
        const collateralTokenID = toBN(randomHex(32));

        shouldWorkWithSplittingAndMerging({
          async prepareTokens() {
            this.collateralMultiToken = await ERC1155Mock.new({
              from: minter
            });
            await this.collateralMultiToken.mint(
              trader.address,
              collateralTokenID,
              collateralTokenCount,
              "0x",
              { from: minter }
            );
          },
          async doSplit(conditionId, partition, amount) {
            return await trader.execCall(
              this.collateralMultiToken,
              "safeTransferFrom",
              trader.address,
              this.conditionalTokens.address,
              collateralTokenID,
              amount,
              web3.eth.abi.encodeParameters(
                ["bytes32", "uint256[]"],
                [conditionId, partition]
              )
            );
          },
          async doMerge(conditionId, partition, amount) {
            return await trader.execCall(
              this.conditionalTokens,
              "merge1155Positions",
              this.collateralMultiToken.address,
              collateralTokenID,
              NULL_BYTES32,
              conditionId,
              partition,
              amount
            );
          },
          async doRedeem(conditionId, indexSets) {
            return await trader.execCall(
              this.conditionalTokens,
              "redeem1155Positions",
              this.collateralMultiToken.address,
              collateralTokenID,
              NULL_BYTES32,
              conditionId,
              indexSets
            );
          },
          async collateralBalanceOf(address) {
            return await this.collateralMultiToken.balanceOf(
              address,
              collateralTokenID
            );
          },
          getPositionForCollection(collectionId) {
            return getPositionId(
              this.collateralMultiToken.address,
              collateralTokenID,
              collectionId
            );
          },
          getExpectedEventCollateralProperties() {
            return {
              collateralToken: this.collateralMultiToken.address,
              collateralTokenID
            };
          }
        });
      });
    }

    context("with an EOA", function() {
      shouldSplitAndMergePositions({
        address: eoaTrader,
        async execCall(contract, method, ...args) {
          return await contract[method](...args, { from: eoaTrader });
        }
      });
    });

    context.skip("with a Forwarder", function() {
      let trader = {};
      before(async function() {
        const forwarder = await Forwarder.new();
        async function forwardCall(contract, method, ...args) {
          // ???: why is reformatting the args necessary here?
          args = args.map(arg =>
            Array.isArray(arg) ? arg.map(a => a.toString()) : arg.toString()
          );

          return await forwarder.call(
            contract.address,
            contract.contract.methods[method](...args).encodeABI(),
            { from: fwdExecutor }
          );
        }

        trader.address = forwarder.address;
        trader.execCall = forwardCall;
      });

      shouldSplitAndMergePositions(trader);
    });

    context.skip("with a Gnosis Safe", function() {
      let trader = {};
      before(async function() {
        const zeroAccount = `0x${"0".repeat(40)}`;
        const safeOwners = Array.from({ length: 2 }, () =>
          web3.eth.accounts.create()
        );
        safeOwners.sort(({ address: a }, { address: b }) =>
          a.toLowerCase() < b.toLowerCase() ? -1 : a === b ? 0 : 1
        );
        const callbackHandler = await DefaultCallbackHandler.new();
        const gnosisSafe = await GnosisSafe.new();
        await gnosisSafe.setup(
          safeOwners.map(({ address }) => address),
          safeOwners.length,
          zeroAccount,
          "0x",
          callbackHandler.address,
          zeroAccount,
          0,
          zeroAccount
        );
        const gnosisSafeTypedDataCommon = {
          types: {
            EIP712Domain: [{ name: "verifyingContract", type: "address" }],
            SafeTx: [
              { name: "to", type: "address" },
              { name: "value", type: "uint256" },
              { name: "data", type: "bytes" },
              { name: "operation", type: "uint8" },
              { name: "safeTxGas", type: "uint256" },
              { name: "baseGas", type: "uint256" },
              { name: "gasPrice", type: "uint256" },
              { name: "gasToken", type: "address" },
              { name: "refundReceiver", type: "address" },
              { name: "nonce", type: "uint256" }
            ],
            SafeMessage: [{ name: "message", type: "bytes" }]
          },
          domain: {
            verifyingContract: gnosisSafe.address
          }
        };

        async function gnosisSafeCall(contract, method, ...args) {
          const safeOperations = {
            CALL: 0,
            DELEGATECALL: 1,
            CREATE: 2
          };
          const nonce = await gnosisSafe.nonce();

          // ???: why is reformatting the args necessary here?
          args = args.map(arg =>
            Array.isArray(arg) ? arg.map(a => a.toString()) : arg.toString()
          );

          const txData = contract.contract.methods[method](...args).encodeABI();
          const signatures = safeOwners.map(safeOwner =>
            ethSigUtil.signTypedData(
              Buffer.from(safeOwner.privateKey.replace("0x", ""), "hex"),
              {
                data: Object.assign(
                  {
                    primaryType: "SafeTx",
                    message: {
                      to: contract.address,
                      value: 0,
                      data: txData,
                      operation: safeOperations.CALL,
                      safeTxGas: 0,
                      baseGas: 0,
                      gasPrice: 0,
                      gasToken: zeroAccount,
                      refundReceiver: zeroAccount,
                      nonce
                    }
                  },
                  gnosisSafeTypedDataCommon
                )
              }
            )
          );
          const tx = await gnosisSafe.execTransaction(
            contract.address,
            0,
            txData,
            safeOperations.CALL,
            0,
            0,
            0,
            zeroAccount,
            zeroAccount,
            `0x${signatures.map(s => s.replace("0x", "")).join("")}`,
            { from: safeExecutor }
          );
          if (tx.logs[0] && tx.logs[0].event === "ExecutionFailed")
            throw new Error(`Safe transaction ${method}(${args}) failed`);
          return tx;
        }

        trader.address = gnosisSafe.address;
        trader.execCall = gnosisSafeCall;
      });

      shouldSplitAndMergePositions(trader);
    });
  });
});