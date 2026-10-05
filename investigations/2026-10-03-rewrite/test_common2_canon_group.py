"""canon_group must collapse a specimen across every namespace it is republished under.

Mosquito-Alert ships the same specimen twice, as `maapi:<uuid>` and `madump:<uuid>`.  The
original regex enumerated `uuid|gbif`, so those two stayed distinct groups and the specimen
straddled the train/test split with 100% label agreement -- invisible to any
label-contradiction check.  These assertions pin the general property (the namespace prefix is
not part of a specimen's identity) rather than a list of namespaces, so the next namespace that
appears is covered without touching this file.
"""
import re
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common2 import canon_group

UUID_A = 'e4f897f3-5742-44f8-a758-1b57399a0656'
UUID_B = '9b1d0c2a-1111-2222-3333-444455556666'


def test_republished_under_two_namespaces_is_one_group():
    assert canon_group('maapi:' + UUID_A) == canon_group('madump:' + UUID_A)


def test_distinct_specimens_stay_distinct_within_a_namespace():
    assert canon_group('maapi:' + UUID_A) != canon_group('maapi:' + UUID_B)


def test_distinct_specimens_stay_distinct_across_namespaces():
    assert canon_group('maapi:' + UUID_A) != canon_group('madump:' + UUID_B)


def test_different_suffixes_never_merge_whatever_the_namespace():
    # The strip trusts the suffix to identify the specimen, so the only thing that must never
    # merge is two different suffixes.  Verified against the real caches: the 148 groups the
    # 14,072-row pool collapses are all gbif/uuid pairs of the same occurrence key, and the 178
    # the 6,264-row BioCLIP cache collapses are all maapi/madump pairs of the same specimen uuid,
    # every one of them label-agreeing.  No suffix space overlaps another namespace's.
    assert canon_group('commons_file:File_Aedes_albopictus_cdc_jpg') != canon_group('maapi:' + UUID_A)
    assert canon_group('inat:12345') != canon_group('gbif:12346')


def test_uuid_and_gbif_numeric_behaviour_is_unchanged():
    # The pre-existing case: a GBIF occurrence key carried under both names.
    assert canon_group('gbif:4950353777') == canon_group('uuid:4950353777') == 'gbif:4950353777'
    assert canon_group('gbif:4950353777') != canon_group('gbif:4950353778')


def test_unnamespaced_key_passes_through():
    assert canon_group('4950353777') == '4950353777'


def test_unknown_future_namespace_is_collapsed_without_a_code_change():
    # The failure mode being fixed is a whitelist silently missing the next namespace; assert the
    # namespace list is open by using a namespace that appears nowhere in the codebase.
    assert canon_group('brandnewfeed:' + UUID_A) == canon_group('maapi:' + UUID_A)
