const ValidatorManagerContract = artifacts.require("ValidatorManagerContract");
const CryptoCards = artifacts.require("CryptoCards");
const RootChain = artifacts.require("RootChain");
import {increaseTimeTo, duration} from './helpers/increaseTime'
import assertRevert from './helpers/assertRevert.js';

const txlib = require('./UTXO.js')

contract("Exits", async function(accounts) {

    const t1 = 3600 * 24 * 3; // 3 days later
    const t2 = 3600 * 24 * 5; // 5 days later

    // Alice registers and has 5 coins, and she deposits 3 of them.
    const ALICE_INITIAL_COINS = 5;
    const ALICE_DEPOSITED_COINS = 3;
    const COINS = [1, 2, 3];

    let cards;
    let plasma;
    let vmc;
    let events;
    let t0;
    let UTXO;

    const blk_1 = 1000
    const blk_2 = 2000
    const blk_3 = 3000
    const blk_4 = 4000

    let [authority, alice, bob, charlie, dylan, elliot, random_guy, random_guy2, challenger, mallory] = accounts;

    beforeEach(async function() {
        vmc = await ValidatorManagerContract.new({from: authority});
        plasma = await RootChain.new(vmc.address, {from: authority});
        cards = await CryptoCards.new(plasma.address);
        await vmc.toggleToken(cards.address);
        await cards.register({from: alice});
        assert.equal(await cards.balanceOf.call(alice), 5);

        let ret;
        for (let i = 0; i < ALICE_DEPOSITED_COINS; i ++) {
            await cards.depositToPlasma(COINS[i], {from: alice});
        }


        assert.equal((await cards.balanceOf.call(alice)).toNumber(), ALICE_INITIAL_COINS - ALICE_DEPOSITED_COINS);
        assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), ALICE_DEPOSITED_COINS);

        const depositEvent = plasma.Deposit({}, {fromBlock: 0, toBlock: 'latest'});
        events = await txlib.Promisify(cb => depositEvent.get(cb));

        // Check that events were emitted properly
        let coin;
        for (let i = 0; i < events.length; i++) {
            coin = events[i].args;
            // assert.equal(coin.slot.toNumber(), i);
            assert.equal(coin.blockNumber.toNumber(), i+1);
            assert.equal(coin.denomination.toNumber(), 1);
            assert.equal(coin.from, alice);
        }

        UTXO = {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()};

    });

    describe('General functionality', function() {
        it('Can submit blocks', async function() {
            await plasma.submitBlock(1000, '0x123')
            await plasma.submitBlock(2000, '0x123')
            await plasma.submitBlock(3000, '0x123')

        })

        it('Cannot submit an older block', async function() {
            await plasma.submitBlock(1000, '0x123')
            await plasma.submitBlock(2000, '0x123')
            await plasma.submitBlock(3000, '0x123')
            assertRevert(plasma.submitBlock(2000, '0x123'))
        })

        it('Can overwrite a block (solves double submission)', async function() {
            await plasma.submitBlock(1000, '0x123')
            await plasma.submitBlock(1000, '0x123')
        })

        it('Cannot withdraw a coin that has not been exited', async function() {
            assert.equal(await txlib.getState(plasma, UTXO.slot), 0, "State should be 0")
            try { 
                await plasma.withdraw(UTXO.slot, { from: alice })
            } catch (e) { 
                assert.ok(e !== undefined)
            }
        })

        it('Only owner of exit can withdraw', async function() {
            t0 = await txlib.exitDeposit(plasma, alice, UTXO)
            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExit(UTXO.slot, {from: random_guy2});
            try { 
                await plasma.withdraw(UTXO.slot, { from: bob })
            } catch (e) { 
                assert.ok(e !== undefined)
            }
            await plasma.withdraw(UTXO.slot, { from: alice })
        })

        it('Bonds get withdrawn correctly', async function() {
            t0 = await txlib.exitDeposit(plasma, alice, UTXO)
            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExit(UTXO.slot, {from: random_guy2});
            await txlib.withdrawBonds(plasma, alice, 0.1);
        })

        // This test proves that even if the operator
        // decides to enable arbitrary accounts as token accounts,
        // they are not able to abuse the system and steal other user's coins
        // due to the `contractAddress` parameter in a coin's state.
        it("Mallory cannot steal ERC721 by manually calling onERC721Received", async function() {
            // Validator triggers mallory as a token contract, 
            // allowing mallory to call the receiver function
            await vmc.toggleToken(mallory);

            let blk = web3.eth.blocknumber;
            // The registered `contractAddress` is `msg.sender` which is mallory's address
            await plasma.onERC721Received(mallory, COINS[1], '0x0', {from: mallory});

            let malloryEvent = plasma.Deposit({from: mallory}, {fromBlock: 0, toBlock: 'latest'});
            events = await txlib.Promisify(cb => malloryEvent.get(cb));
            let UTXO = {'slot': events[0]['args'].slot, 'block': events[0]['args'].blockNumber.toNumber()};

            // Mallory now has a UTXO of `COINS[1]` which is owned by Alice.
            // Tries to exit it.
            // Note however, that the `contractAddress` in the coin's state is not 
            // the ERC721, but Mallory's address!
            t0 = await txlib.exitDeposit(plasma, mallory, UTXO)
            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExit(UTXO.slot, {from: random_guy});

            // However mallory cannot withdraw the coins since `contractAddress` 
            // of the coin is actually mallory's address and NOT the actual token address
            assertRevert(plasma.withdraw(UTXO.slot, {from: mallory}));

            // Nonetheless, Mallory's exit was actually valid and can withdraw the bond
            await txlib.withdrawBonds(plasma, mallory, 0.1)
        });

    });

    describe('Exits', async function() {
        it('State transitions are correct (cannot finalize before maturity period)', async function() {
            assert.equal(await txlib.getState(plasma, UTXO.slot), 0, "State should be 0")

            t0 = await txlib.exitDeposit(plasma, alice, UTXO)
            assert.equal(await txlib.getState(plasma, UTXO.slot), 1, "State should be 1")

            await increaseTimeTo(t0 + t1);
            await plasma.finalizeExit(UTXO.slot, {from: random_guy2});
            assert.equal(await txlib.getState(plasma, UTXO.slot), 1, "State should still be 1")

            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExit(UTXO.slot, {from: random_guy2});
            assert.equal(await txlib.getState(plasma, UTXO.slot), 2, "State should be 2")
        })


        it('C = Deposit, PC = Null', async function() {
            t0 = await txlib.exitDeposit(plasma, alice, UTXO)
            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExit(UTXO.slot, {from: random_guy2});
            await plasma.withdraw(UTXO.slot, {from: alice});
            assert.equal(await cards.balanceOf.call(alice), 3);
            assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);
            await txlib.withdrawBonds(plasma, alice, 0.1);
        });

        it('C = Non-Deposit, PC = Deposit', async function() {
            let alice_to_bob = txlib.createUTXO(UTXO.slot, UTXO.block, alice, bob);
            let txs = [alice_to_bob.leaf]
            let tree_bob = await txlib.submitTransactions(authority, plasma, blk_1, txs);

            t0 = await txlib.exit(plasma, bob,
                UTXO.slot,
                
                { 'block': blk_1, 'tx': alice_to_bob },
                tree_bob.createMerkleProof(UTXO.slot),

                { 'block': UTXO.block, 'tx': txlib.createUTXO(UTXO.slot, 0, alice, alice) },
                '0x',
            )

            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExit(UTXO.slot, {from: random_guy2});
            await plasma.withdraw(UTXO.slot, {from: bob});
            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 1);
            assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);
            await txlib.withdrawBonds(plasma, bob, 0.1);
        });
        
        it('C = Non-Deposit, PC = Non-Deposit', async function() {
            let alice_to_bob = txlib.createUTXO(UTXO.slot, UTXO.block, alice, bob);
            let txs = [alice_to_bob.leaf]
            let tree_bob = await txlib.submitTransactions(authority, plasma, blk_1, txs);

            let bob_to_charlie = txlib.createUTXO(UTXO.slot, blk_1, bob, charlie);
            txs = [bob_to_charlie.leaf]
            let tree_charlie = await txlib.submitTransactions(authority, plasma, blk_2, txs);

            t0 = await txlib.exit(plasma, charlie,
                UTXO.slot,
                
                { 'block': blk_2, 'tx': bob_to_charlie },
                tree_charlie.createMerkleProof(UTXO.slot),

                { 'block': blk_1, 'tx': alice_to_bob },
                tree_bob.createMerkleProof(UTXO.slot),
            )

            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExit(UTXO.slot, {from: random_guy2});
            await plasma.withdraw(UTXO.slot, {from: charlie});
            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 0);
            assert.equal(await cards.balanceOf.call(charlie), 1);
            assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);
            await txlib.withdrawBonds(plasma, charlie, 0.1);
        });

        it('Cannot exit another user\'s coin', async function() {
            let alice_to_bob = txlib.createUTXO(UTXO.slot, UTXO.block, alice, bob);
            let txs = [alice_to_bob.leaf]
            let tree_bob = await txlib.submitTransactions(authority, plasma, blk_1, txs);

            let bob_to_charlie = txlib.createUTXO(UTXO.slot, blk_1, bob, charlie);
            txs = [bob_to_charlie.leaf]
            let tree_charlie = await txlib.submitTransactions(authority, plasma, blk_2, txs);

            try { 
                await txlib.exit(plasma, bob, // bob instead of charlie
                    UTXO.slot,
                    
                    { 'block': blk_2, 'tx': bob_to_charlie },
                    tree_charlie.createMerkleProof(UTXO.slot),

                    { 'block': blk_1, 'tx': alice_to_bob },
                    tree_bob.createMerkleProof(UTXO.slot),
                )
            } catch (e) { 
                assert.ok(e !== undefined)
            }
            assert.equal(await txlib.getState(plasma, UTXO.slot), 0, "State should be 0")
        });

        it('Only 1 exit can be active for a coin', async function() {
            let alice_to_bob = txlib.createUTXO(UTXO.slot, UTXO.block, alice, bob);
            let txs = [alice_to_bob.leaf]
            let tree_bob = await txlib.submitTransactions(authority, plasma, blk_1, txs);

            let bob_to_charlie = txlib.createUTXO(UTXO.slot, blk_1, bob, charlie);
            txs = [bob_to_charlie.leaf]
            let tree_charlie = await txlib.submitTransactions(authority, plasma, blk_2, txs);

            t0 = await txlib.exitDeposit(plasma, alice, UTXO)
            assert.equal(await txlib.getState(plasma, UTXO.slot), 1, "State should be 1")
            try { 
                await txlib.exit(plasma, charlie,
                    UTXO.slot,
                    
                    { 'block': blk_2, 'tx': bob_to_charlie },
                    tree_charlie.createMerkleProof(UTXO.slot),

                    { 'block': blk_1, 'tx': alice_to_bob },
                    tree_bob.createMerkleProof(UTXO.slot),
                )
            } catch (e) { 
                assert.ok(e !== undefined)
            }
            // In this case, Charlie should challenge to cancel the first exit.
        });

    });

    // If it works for 2 coins, proof by induction it will work for N coins >2

    describe('Multiple coins', function() {

        it('1 User exits multiple coins', async function() {
            let UTXO = [{'slot': events[1]['args'].slot, 'block': events[1]['args'].blockNumber.toNumber()},
                {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()}];
            const slots = UTXO.map(u => u.slot)
            let alice_to_bob = {};
            let txs = [];
            for (let i in UTXO) {
                let aUTXO = UTXO[i];
                let tx = txlib.createUTXO(aUTXO.slot, aUTXO.block, alice, bob);
                alice_to_bob[aUTXO.slot] = tx;
                txs.push(tx.leaf);
            }

            // Tree contains both transactions
            let tree_bob = await txlib.submitTransactions(authority, plasma, blk_1, txs);
            let exitBlock = 1000;
            // Block 1000 has now been checkpointed with both transactions that give ownership of the coins to Bob
            // UTXO 1 was deposited at Block 2, UTXO 2 was created at block 3

            for (let i in UTXO) {
                let aUTXO = UTXO[i];

                t0 = await txlib.exit(plasma, bob,
                    aUTXO.slot,

                    { 'block': blk_1, 'tx': alice_to_bob[aUTXO.slot] },
                    tree_bob.createMerkleProof(aUTXO.slot),

                    { 'block': aUTXO.block, 'tx': txlib.createUTXO(aUTXO.slot, 0, alice, alice) },
                    '0x'
                )
            }

            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits(slots, {from: random_guy2});
            UTXO.forEach(async function(aUTXO) {
                await plasma.withdraw(aUTXO.slot, {from : bob});
            });
            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 2);
            assert.equal(await cards.balanceOf.call(plasma.address), 1);

            // Bob is also able to withdraw his deposit bonds of 0.2 ether for 2 exits
            await txlib.withdrawBonds(plasma, bob, 0.2);
        });
        it('A->B & A->B->C. B and C exit', async function() {
            let UTXO = [{'slot': events[1]['args'].slot, 'block': events[1]['args'].blockNumber.toNumber()},
                        {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()}];
            const slots = UTXO.map(u => u.slot)

            let alice_to_bob = {};
            let txs = [];
            UTXO.forEach(function(aUTXO) {
                let tx = txlib.createUTXO(aUTXO.slot, aUTXO.block, alice, bob);
                alice_to_bob[aUTXO.slot] = tx;
                txs.push(tx.leaf);
            });

            // Tree contains both transactions
            let tree_bob = await txlib.submitTransactions(authority, plasma, 1000, txs);

            // Bob has ownership of the 2 coin's and now he gives 1 to Charlie
            let bob_to_charlie = txlib.createUTXO(UTXO[0].slot, UTXO[0].block, bob, charlie);
            txs = [ bob_to_charlie.leaf ];
            let tree_charlie = await txlib.submitTransactions(authority, plasma, 2000, txs);

            t0 = await txlib.exit(plasma, bob,
                UTXO[1].slot,

                { 'block': blk_1, 'tx': alice_to_bob[UTXO[1].slot] },
                tree_bob.createMerkleProof(UTXO[1].slot),

                { 'block': UTXO[1].block, 'tx': txlib.createUTXO(UTXO[1].slot, 0, alice, alice) },
                '0x'
            )

            t0 = await txlib.exit(plasma, charlie,
                UTXO[0].slot,

                { 'block': blk_2, 'tx': bob_to_charlie },
                tree_charlie.createMerkleProof(UTXO[0].slot),

                { 'block': blk_1, 'tx': alice_to_bob[UTXO[0].slot] },
                tree_bob.createMerkleProof(UTXO[0].slot),

            )

            // After the exit is matured and finalized, bob and charlie can withdraw the coin.
            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits(slots, {from: random_guy2});

            await plasma.withdraw(UTXO[1].slot, {from: bob});
            await plasma.withdraw(UTXO[0].slot, {from: charlie});
            assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
            assert.equal((await cards.balanceOf.call(bob)).toNumber(), 1);
            assert.equal((await cards.balanceOf.call(charlie)).toNumber(), 1);
            assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 1);

            await plasma.withdrawBonds({from: bob});
            await plasma.withdrawBonds({from: charlie});
            let withdrewBonds = plasma.WithdrewBonds({}, {fromBlock: 0, toBlock: 'latest'});
            let e = await txlib.Promisify(cb => withdrewBonds.get(cb));
            let withdraw = e[0].args;
            assert.equal(withdraw.from, bob);
            assert.equal(withdraw.amount, web3.toWei(0.1, 'ether'));
            withdraw = e[1].args;
            assert.equal(withdraw.from, charlie);
            assert.equal(withdraw.amount, web3.toWei(0.1, 'ether'));

        });

        it('A->B & A->C. B and C exit', async function() {
            let UTXO = [{'slot': events[1]['args'].slot, 'block': events[1]['args'].blockNumber.toNumber()},
                        {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()}];
            const slots = UTXO.map(u => u.slot)
            let txs = [];
            let alice_to_bob = txlib.createUTXO(UTXO[0].slot, UTXO[0].block, alice, bob);
            let alice_to_charlie = txlib.createUTXO(UTXO[1].slot, UTXO[1].block, alice, charlie);
            txs = [alice_to_bob.leaf, alice_to_charlie.leaf]; // push leaf
            let tree = await txlib.submitTransactions(authority, plasma, 1000, txs);

            t0 = await txlib.exit(plasma, bob,
                UTXO[0].slot,

                { 'block': blk_1, 'tx': alice_to_bob },
                tree.createMerkleProof(UTXO[0].slot),

                { 'block': UTXO[0].block, 'tx': txlib.createUTXO(UTXO[0].slot, 0, alice, alice) },
                '0x'
            )

            t0 = await txlib.exit(plasma, charlie,
                UTXO[1].slot,

                { 'block': blk_1, 'tx': alice_to_charlie },
                tree.createMerkleProof(UTXO[1].slot),

                { 'block': UTXO[1].block, 'tx': txlib.createUTXO(UTXO[1].slot, 0, alice, alice) },
                '0x'
            )

            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits(slots, {from: random_guy2});
            await plasma.withdraw(UTXO[0].slot, {from: bob});
            await plasma.withdraw(UTXO[1].slot, {from: charlie});

            assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
            assert.equal((await cards.balanceOf.call(bob)).toNumber(), 1);
            assert.equal((await cards.balanceOf.call(charlie)).toNumber(), 1);
            assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 1);

            // Charlie is also able to withdraw his deposit bonds of 0.2 ether for 2 exits
            await plasma.withdrawBonds({from: bob});
            await plasma.withdrawBonds({from: charlie});
            let withdrewBonds = plasma.WithdrewBonds({}, {fromBlock: 0, toBlock: 'latest'});
            let e = await txlib.Promisify(cb => withdrewBonds.get(cb));
            let withdraw = e[0].args;
            assert.equal(withdraw.from, bob);
            assert.equal(withdraw.amount, web3.toWei(0.1, 'ether'));
            withdraw = e[1].args;
            assert.equal(withdraw.from, charlie);
            assert.equal(withdraw.amount, web3.toWei(0.1, 'ether'));
        });

        it('A->B->C & A->C, C exits both', async function() {
            let UTXO = [{'slot': events[1]['args'].slot, 'block': events[1]['args'].blockNumber.toNumber()},
                        {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()}];
            const slots = UTXO.map(u => u.slot)
            let txs = [];
            let alice_to_bob = txlib.createUTXO(UTXO[0].slot, UTXO[0].block, alice, bob);
            let alice_to_charlie = txlib.createUTXO(UTXO[1].slot, UTXO[1].block, alice, charlie);
            txs = [alice_to_bob.leaf, alice_to_charlie.leaf]; // push leaf
            let tree_1000 = await txlib.submitTransactions(authority, plasma, 1000, txs);

            // Bob and Charlie own a coin each.

            let bob_to_charlie = txlib.createUTXO(UTXO[0].slot, 1000, bob, charlie);
            txs = [bob_to_charlie.leaf]
            let tree_2000 = await txlib.submitTransactions(authority, plasma, 2000, txs);

            t0 = await txlib.exit(plasma, charlie,
                UTXO[1].slot,

                { 'block': blk_1, 'tx': alice_to_charlie },
                tree_1000.createMerkleProof(UTXO[1].slot),

                { 'block': UTXO[1].block, 'tx': txlib.createUTXO(UTXO[1].slot, 0, alice, alice) },
                '0x'
            )

            t0 = await txlib.exit(plasma, charlie,
                UTXO[0].slot,

                { 'block': blk_2, 'tx': bob_to_charlie },
                tree_2000.createMerkleProof(UTXO[0].slot),

                { 'block': blk_1, 'tx': alice_to_bob },
                tree_1000.createMerkleProof(UTXO[0].slot),

            )
            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits(slots, {from: random_guy2});

            await plasma.withdraw(UTXO[0].slot, {from: charlie});
            await plasma.withdraw(UTXO[1].slot, {from: charlie});

            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 0);
            assert.equal(await cards.balanceOf.call(charlie), 2);
            assert.equal(await cards.balanceOf.call(plasma.address), 1);

            await plasma.withdrawBonds({from: charlie});
            let withdrewBonds = plasma.WithdrewBonds({}, {fromBlock: 0, toBlock: 'latest'});
            let e = await txlib.Promisify(cb => withdrewBonds.get(cb));
            let withdraw = e[0].args;
            assert.equal(withdraw.from, charlie);
            assert.equal(withdraw.amount, web3.toWei(0.1 * 2, 'ether'));
        });

        it("Alice sends Bob UTXO 2, submits it, Bob deposits his coin and sends Alice UTXO 4, submits it, both exit", async function() {
            let alice_to_bob = txlib.createUTXO(UTXO.slot, UTXO.block, alice, bob);
            let txs = [alice_to_bob.leaf];
            let tree_1000 = await txlib.submitTransactions(authority, plasma, blk_1, txs);

            // Bob deposits Coin 7, which generates a new UTXO in the Plasma chain.
            await cards.register({from: bob});
            await cards.depositToPlasma(7, {from: bob});
            const depositEvent = plasma.Deposit({}, {fromBlock: 0, toBlock: 'latest'});
            events = await txlib.Promisify(cb => depositEvent.get(cb));
            let bobCoin = events[events.length - 1].args;
            let slot = bobCoin.slot;
            let block = await plasma.getPlasmaCoin.call(slot);
            block = block[1].toNumber();

            let bob_to_alice = txlib.createUTXO(slot, block, bob, alice);
            txs = [bob_to_alice.leaf];
            let tree_2000 = await txlib.submitTransactions(authority, plasma, blk_2, txs);

            t0 = await txlib.exit(plasma, bob,
                UTXO.slot,
                
                { 'block': blk_1, 'tx': alice_to_bob },
                tree_1000.createMerkleProof(UTXO.slot),

                { 'block': UTXO.block, 'tx': txlib.createUTXO(UTXO.slot, 0, alice, alice) },
                '0x',
            )

            t0 = await txlib.exit(plasma, alice,
                slot,
                
                { 'block': blk_2, 'tx': bob_to_alice },
                tree_2000.createMerkleProof(slot),

                { 'block': block, 'tx': txlib.createUTXO(slot, 0, bob, bob) },
                '0x',
            )

            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits([UTXO.slot, slot], {from: random_guy2});
            assert.equal(await txlib.getState(plasma, UTXO.slot), 2, "State should be 2")
            assert.equal(await txlib.getState(plasma, slot), 2, "State should be 2")
        });


    })
});
