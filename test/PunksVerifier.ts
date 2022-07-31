import { expect } from "chai";
import hre, { waffle, upgrades } from "hardhat";

const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
    PunksVerifier,
    AssetVault,
    CallWhitelist,
    VaultFactory,
    CryptoPunksMarket
} from "../typechain";
import { deploy } from "./utils/contracts";

import { encodeInts, initializeBundle } from "./utils/loans";

type Signer = SignerWithAddress;

interface TestContext {
    verifier: PunksVerifier;
    punks: CryptoPunksMarket;
    vaultFactory: VaultFactory;
    deployer: Signer;
    user: Signer;
    signers: Signer[];
}

describe("PunksVerifier", () => {
    /**
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const signers: Signer[] = await hre.ethers.getSigners();
        const [deployer, user] = signers;

        const whitelist = <CallWhitelist>await deploy("CallWhitelist", deployer, []);
        const punks = <CryptoPunksMarket>await deploy("CryptoPunksMarket", signers[0], []);
        const verifier = <PunksVerifier>await deploy("PunksVerifier", deployer, [punks.address]);

        const vaultTemplate = <AssetVault>await deploy("AssetVault", deployer, []);
        const VaultFactoryFactory = await hre.ethers.getContractFactory("VaultFactory");
        const vaultFactory = <VaultFactory>await upgrades.deployProxy(
            VaultFactoryFactory,
            [vaultTemplate.address, whitelist.address],
            {
                kind: "uups",
            },
        );

        await punks.allInitialOwnersAssigned();

        return {
            verifier,
            punks,
            vaultFactory,
            deployer,
            user,
            signers: signers.slice(2),
        };
    };

    describe("verifyPredicates", () => {
        let ctx: TestContext;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
        });

        it("fails for an invalid tokenId", async () => {
            const { vaultFactory, user, verifier } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);

            // Will revert because 20000 is not a valid punk token Id
            await expect(verifier.verifyPredicates(encodeInts([20000]), bundleAddress)).to.be.revertedWith("IV_InvalidTokenId");
        });

        it("verifies a specific punk token id", async () => {
            const { vaultFactory, user, punks, verifier } = ctx;

            // Start 2 bundles
            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const bundleId2 = await initializeBundle(vaultFactory, user);
            const bundleAddress2 = await vaultFactory.instanceAt(bundleId2);

            // Fund both bundles with different token IDs
            const tokenId = 5555;
            await punks.connect(user).getPunk(tokenId);
            await punks.connect(user).transferPunk(bundleAddress, tokenId);

            const tokenId2 = 7777;
            await punks.connect(user).getPunk(tokenId2);
            await punks.connect(user).transferPunk(bundleAddress2, tokenId2);

            // First bundle should have item
            expect(await verifier.verifyPredicates(encodeInts([tokenId]), bundleAddress)).to.be.true;
            // Second bundle should not
            expect(await verifier.verifyPredicates(encodeInts([tokenId]), bundleAddress2)).to.be.false;
        });

        it("verifies punks any token id", async () => {
            const { vaultFactory, user, punks, verifier } = ctx;

            // Start 3 bundles
            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const bundleId2 = await initializeBundle(vaultFactory, user);
            const bundleAddress2 = await vaultFactory.instanceAt(bundleId2);
            const bundleId3 = await initializeBundle(vaultFactory, user);
            const bundleAddress3 = await vaultFactory.instanceAt(bundleId3);

            // Fund both bundles with different token IDs
            const tokenId = 5555;
            await punks.connect(user).getPunk(tokenId);
            await punks.connect(user).transferPunk(bundleAddress, tokenId);

            const tokenId2 = 7777;
            await punks.connect(user).getPunk(tokenId2);
            await punks.connect(user).transferPunk(bundleAddress2, tokenId2);

            // First and bundle should have item
            expect(await verifier.verifyPredicates(encodeInts([-1]), bundleAddress)).to.be.true;
            expect(await verifier.verifyPredicates(encodeInts([-1]), bundleAddress2)).to.be.true;

            // Third should not
            expect(await verifier.verifyPredicates(encodeInts([-1]), bundleAddress3)).to.be.false;
        });

        it("verifies multiple punk token ids", async () => {
            const { vaultFactory, user, punks, verifier } = ctx;

            // Start 3 bundles
            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const bundleId2 = await initializeBundle(vaultFactory, user);
            const bundleAddress2 = await vaultFactory.instanceAt(bundleId2);
            const bundleId3 = await initializeBundle(vaultFactory, user);
            const bundleAddress3 = await vaultFactory.instanceAt(bundleId3);

            // Fund both bundles with different token IDs
            const tokenId = 5555;
            await punks.connect(user).getPunk(tokenId);
            await punks.connect(user).transferPunk(bundleAddress, tokenId);

            const tokenId2 = 7777;
            await punks.connect(user).getPunk(tokenId2);
            await punks.connect(user).transferPunk(bundleAddress2, tokenId2);

            const tokenId3 = 8888;
            await punks.connect(user).getPunk(tokenId3);
            await punks.connect(user).transferPunk(bundleAddress, tokenId3);

            expect(await verifier.verifyPredicates(encodeInts([5555, 8888]), bundleAddress)).to.be.true;
            expect(await verifier.verifyPredicates(encodeInts([7777, 8888]), bundleAddress2)).to.be.false;
            expect(await verifier.verifyPredicates(encodeInts([5555, 7777]), bundleAddress3)).to.be.false;
        });
    });
});
