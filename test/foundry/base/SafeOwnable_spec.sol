pragma solidity 0.7.6;

import "forge-std/Test.sol";
import "../../../contracts/base/SafeOwnable.sol";

contract SafeOwnable_impl is SafeOwnable {
    function initialize() external initializer {
        __SafeOwnable_init();
    }
}

contract SafeOwnable_spec is Test {
    address private constant _ZERO_ADDRESS = address(0);

    SafeOwnable_impl public safeOwnable;
    address public nonOwnerAddress;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        safeOwnable = new SafeOwnable_impl();
        safeOwnable.initialize();
        nonOwnerAddress = makeAddr("nonOwnerAddress");
    }

    function testCannot_onlyOwner() public {
        vm.startPrank(nonOwnerAddress);

        vm.expectRevert(bytes("SO_CNO"));
        safeOwnable.renounceOwnership();

        vm.expectRevert(bytes("SO_CNO"));
        _set_nonOwnerAddress_as_candidate();
    }

    function test_renounceOwnership_should_emit_event() public {
        vm.expectEmit(false, false, false, true);
        emit OwnershipTransferred(address(this), _ZERO_ADDRESS);
        safeOwnable.renounceOwnership();

        assertEq(safeOwnable.owner(), _ZERO_ADDRESS);
        assertEq(safeOwnable.candidate(), _ZERO_ADDRESS);
    }

    function test_setOwner() public {
        _set_nonOwnerAddress_as_candidate();
        assertEq(safeOwnable.candidate(), nonOwnerAddress);
    }

    function testCannot_setOwner_candidate_is_zero_address() public {
        vm.expectRevert(bytes("SO_NW0"));
        safeOwnable.setOwner(_ZERO_ADDRESS);
    }

    function testCannot_setOwner_candidate_is_already_owner() public {
        vm.expectRevert(bytes("SO_SAO"));
        safeOwnable.setOwner(address(this));
    }

    function testCannot_setOwner_candidate_is_already_candidate() public {
        _set_nonOwnerAddress_as_candidate();

        vm.expectRevert(bytes("SO_SAC"));
        _set_nonOwnerAddress_as_candidate();
    }

    function test_updateOwner_should_emit_event() public {
        _set_nonOwnerAddress_as_candidate();

        vm.expectEmit(false, false, false, true);
        emit OwnershipTransferred(address(this), nonOwnerAddress);
        vm.prank(nonOwnerAddress);
        safeOwnable.updateOwner();

        assertEq(safeOwnable.owner(), nonOwnerAddress);
        assertEq(safeOwnable.candidate(), _ZERO_ADDRESS);
    }

    function testCannot_updateOwner_candidate_is_zero_address() public {
        vm.expectRevert(bytes("SO_C0"));
        safeOwnable.updateOwner();
    }

    function testCannot_updateOwner_caller_is_not_candidate() public {
        _set_nonOwnerAddress_as_candidate();

        vm.expectRevert(bytes("SO_CNC"));
        safeOwnable.updateOwner();
    }

    function _set_nonOwnerAddress_as_candidate() internal {
        safeOwnable.setOwner(nonOwnerAddress);
    }
}
