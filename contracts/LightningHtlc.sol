// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev The ERC-20 calls this contract makes.
interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @dev EIP-3009 as implemented by USDC (FiatToken v2 and later).
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/**
 * @title LightningHtlc
 * @notice Escrows ERC-20 tokens (USDC) against the payment hash of a Lightning invoice.
 *
 * A payer locks tokens under `paymentHash = sha256(preimage)`, the hash in a BOLT11
 * invoice. The claimer (the solver) can take them only by revealing the preimage, which
 * it learns only once that invoice has been paid. From `timelock` on, the refunder can
 * take them back instead, and the claimer can hand them back at any time with `cancel` (the
 * solver does this for an order it declines before paying anything). This is the outside-network half of a corridor swap: the same
 * hash also locks the Arkade lockup that pays the invoice.
 *
 * A swap is identified by `swapId = keccak256(abi.encode(paymentHash, token, refunder,
 * claimer, amount, timelock))`. Only its status is stored, and each id can be used once.
 *
 * Tokens that charge a fee on transfer are not supported.
 */
contract LightningHtlc {
    enum Status {
        None,
        Locked,
        Claimed,
        Refunded
    }

    /// @notice Status of every swap id this contract has seen.
    mapping(bytes32 swapId => Status) public swaps;

    event Locked(
        bytes32 indexed swapId,
        bytes32 indexed paymentHash,
        address indexed claimer,
        address token,
        address refunder,
        uint256 amount,
        uint256 timelock
    );
    event Claimed(bytes32 indexed swapId, bytes32 indexed paymentHash, bytes32 preimage);
    event Refunded(bytes32 indexed swapId, bytes32 indexed paymentHash);

    error InvalidAddress();
    error NotClaimer();
    error InvalidAmount();
    error InvalidTimelock(uint256 timelock);
    error SwapExists(bytes32 swapId);
    error SwapNotLocked(bytes32 swapId);
    error TimelockNotReached(uint256 timelock);
    error TransferFailed();

    /// @notice The id a swap with these terms has.
    function swapIdOf(
        bytes32 paymentHash,
        address token,
        address refunder,
        address claimer,
        uint256 amount,
        uint256 timelock
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(paymentHash, token, refunder, claimer, amount, timelock));
    }

    /**
     * @notice Lock `amount` of `token` from the caller, who becomes the refunder.
     * @dev The caller must have approved this contract for `amount` first.
     */
    function lock(bytes32 paymentHash, address token, address claimer, uint256 amount, uint256 timelock)
        external
        returns (bytes32 swapId)
    {
        swapId = _open(paymentHash, token, msg.sender, claimer, amount, timelock);
        _call(token, abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)));
    }

    /**
     * @notice Lock `amount` of `token` with an EIP-3009 `ReceiveWithAuthorization` that
     * `refunder` signed. Anyone may submit it, so the payer needs no gas.
     * @dev The authorization's nonce must be the swap id, which binds the signature to every
     * term of the swap: a relayer cannot change the hash, claimer, amount or timelock.
     */
    function lockWithAuthorization(
        bytes32 paymentHash,
        address token,
        address refunder,
        address claimer,
        uint256 amount,
        uint256 timelock,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (bytes32 swapId) {
        swapId = _open(paymentHash, token, refunder, claimer, amount, timelock);
        IERC3009(token).receiveWithAuthorization(
            refunder, address(this), amount, validAfter, validBefore, swapId, v, r, s
        );
    }

    /**
     * @notice Pay a locked swap to its claimer by revealing the preimage of its payment hash.
     * @dev Anyone may submit the claim; the tokens always go to `claimer`.
     */
    function claim(bytes32 preimage, address token, address refunder, address claimer, uint256 amount, uint256 timelock)
        external
    {
        bytes32 paymentHash = sha256(abi.encodePacked(preimage));
        bytes32 swapId = swapIdOf(paymentHash, token, refunder, claimer, amount, timelock);
        if (swaps[swapId] != Status.Locked) revert SwapNotLocked(swapId);
        swaps[swapId] = Status.Claimed;
        emit Claimed(swapId, paymentHash, preimage);
        _call(token, abi.encodeCall(IERC20.transfer, (claimer, amount)));
    }

    /**
     * @notice Return a locked swap to its refunder once its timelock has passed.
     * @dev Anyone may submit the refund; the tokens always go to `refunder`.
     */
    function refund(bytes32 paymentHash, address token, address refunder, address claimer, uint256 amount, uint256 timelock)
        external
    {
        bytes32 swapId = swapIdOf(paymentHash, token, refunder, claimer, amount, timelock);
        if (swaps[swapId] != Status.Locked) revert SwapNotLocked(swapId);
        if (block.timestamp < timelock) revert TimelockNotReached(timelock);
        swaps[swapId] = Status.Refunded;
        emit Refunded(swapId, paymentHash);
        _call(token, abi.encodeCall(IERC20.transfer, (refunder, amount)));
    }

    /**
     * @notice Hand a locked swap straight back to its refunder. Only the claimer may do this: it
     * gives up the claim, so the refunder need not wait for the timelock.
     */
    function cancel(bytes32 paymentHash, address token, address refunder, address claimer, uint256 amount, uint256 timelock)
        external
    {
        if (msg.sender != claimer) revert NotClaimer();
        bytes32 swapId = swapIdOf(paymentHash, token, refunder, claimer, amount, timelock);
        if (swaps[swapId] != Status.Locked) revert SwapNotLocked(swapId);
        swaps[swapId] = Status.Refunded;
        emit Refunded(swapId, paymentHash);
        _call(token, abi.encodeCall(IERC20.transfer, (refunder, amount)));
    }

    function _open(
        bytes32 paymentHash,
        address token,
        address refunder,
        address claimer,
        uint256 amount,
        uint256 timelock
    ) private returns (bytes32 swapId) {
        if (token.code.length == 0 || refunder == address(0) || claimer == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (timelock <= block.timestamp) revert InvalidTimelock(timelock);
        swapId = swapIdOf(paymentHash, token, refunder, claimer, amount, timelock);
        if (swaps[swapId] != Status.None) revert SwapExists(swapId);
        swaps[swapId] = Status.Locked;
        emit Locked(swapId, paymentHash, claimer, token, refunder, amount, timelock);
    }

    /// @dev Calls a token, accepting both `true` and an empty return as success.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
