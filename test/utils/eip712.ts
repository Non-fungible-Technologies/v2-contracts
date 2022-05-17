import hre from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumberish } from "ethers";
import { LoanTerms, ItemsPayload } from "./types";
import { fromRpcSig, ECDSASignature } from "ethereumjs-util";
import { isBigNumberish } from "@ethersproject/bignumber/lib/bignumber";

interface TypeData {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    types: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    primaryType: any;
}
export interface PermitData {
    owner: string;
    spender: string;
    tokenId: BigNumberish;
    nonce: number;
    deadline: BigNumberish;
}

const typedPermitData: TypeData = {
    types: {
        Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "tokenId", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
        ],
    },
    primaryType: "Permit" as const,
};

const typedLoanTermsData: TypeData = {
    types: {
        LoanTerms: [
            { name: "durationSecs", type: "uint32" },
            { name: "numInstallments", type: "uint24" },
            { name: "interestRate", type: "uint200" },
            { name: "principal", type: "uint256" },
            { name: "collateralAddress", type: "address" },
            { name: "collateralId", type: "uint256" },
            { name: "payableCurrency", type: "address" },
            { name: "nonce", type: "uint160" },
        ],
    },
    primaryType: "LoanTerms" as const,
};

const typedLoanItemsData: TypeData = {
    types: {
        LoanTermsWithItems: [
            { name: "durationSecs", type: "uint32" },
            { name: "numInstallments", type: "uint24" },
            { name: "interestRate", type: "uint200" },
            { name: "principal", type: "uint256" },
            { name: "collateralAddress", type: "address" },
            { name: "itemsHash", type: "bytes32" },
            { name: "payableCurrency", type: "address" },
            { name: "nonce", type: "uint160" },
        ],
    },
    primaryType: "LoanTermsWithItems" as const,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildData = (verifyingContract: string, name: string, version: string, message: any, typeData: TypeData) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const chainId = hre.network.config.chainId!;
    return Object.assign({}, typeData, {
        domain: {
            name,
            version,
            chainId,
            verifyingContract,
        },
        message,
    });
};

/**
 * Create an EIP712 signature for loan terms
 * @param verifyingContract The address of the contract that will be verifying this signature
 * @param name The name of the contract that will be verifying this signature
 * @param terms the LoanTerms object to sign
 * @param signer The EOA to create the signature
 * @param version The EIP712 version of the contract to use
 * @param nonce The signature nonce
 */
export async function createLoanTermsSignature(
    verifyingContract: string,
    name: string,
    terms: LoanTerms,
    signer: SignerWithAddress,
    version = "1",
    nonce: BigNumberish,
): Promise<ECDSASignature> {
    const data = buildData(verifyingContract, name, version, { ...terms, nonce }, typedLoanTermsData);
    const signature = await signer._signTypedData(data.domain, data.types, data.message);

    return fromRpcSig(signature);
}

/**
 * Create an EIP712 signature for loan terms
 * @param verifyingContract The address of the contract that will be verifying this signature
 * @param name The name of the contract that will be verifying this signature
 * @param terms the LoanTerms object to sign
 * @param signer The EOA to create the signature
 * @param version The EIP712 version of the contract to use
 * @param nonce The signature nonce
 */
export async function createLoanItemsSignature(
    verifyingContract: string,
    name: string,
    terms: LoanTerms,
    itemsHash: string,
    signer: SignerWithAddress,
    version = "1",
    nonce = "1",
): Promise<ECDSASignature> {
    const message: ItemsPayload = {
        durationSecs: terms.durationSecs,
        principal: terms.principal,
        interestRate: terms.interestRate,
        collateralAddress: terms.collateralAddress,
        itemsHash,
        payableCurrency: terms.payableCurrency,
        numInstallments: terms.numInstallments,
        nonce,
    };

    const data = buildData(verifyingContract, name, version, message, typedLoanItemsData);
    // console.log("This is data:");
    // console.log(JSON.stringify(data, null, 4));
    const signature = await signer._signTypedData(data.domain, data.types, data.message);

    return fromRpcSig(signature);
}

/**
 * Create an EIP712 signature for ERC721 permit
 * @param verifyingContract The address of the contract that will be verifying this signature
 * @param name The name of the contract that will be verifying this signature
 * @param permitData the data of the permit to sign
 * @param signer The EOA to create the signature
 */
export async function createPermitSignature(
    verifyingContract: string,
    name: string,
    permitData: PermitData,
    signer: SignerWithAddress,
): Promise<ECDSASignature> {
    const data = buildData(verifyingContract, name, "1", permitData, typedPermitData);
    const signature = await signer._signTypedData(data.domain, data.types, data.message);

    return fromRpcSig(signature);
}
